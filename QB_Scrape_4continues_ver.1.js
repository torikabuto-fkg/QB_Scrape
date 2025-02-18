const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const pdfMake = require('pdfmake/build/pdfmake');
const vfsFonts = require('./build/vfs_fonts.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sizeOf = require('image-size');

// vfs登録（PDFMake用フォントファイルの仮想ファイルシステム）
pdfMake.vfs = vfsFonts.pdfMake.vfs;

// フォント設定（例：日本語用フォント NotoSansJP を利用）
const fonts = {
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  },
  NotoSansJP: {
    normal: 'NotoSansJP-Regular.ttf',
    bold: 'NotoSansJP-Bold.ttf'
  }
};
pdfMake.fonts = fonts;

/**
 * Puppeteer のページから Cookie 情報を取得し、
 * "name1=value1; name2=value2; ..." の形式に整形する関数
 * @param {Page} page - Puppeteer の page インスタンス
 * @returns {Promise<string>}
 */
async function getCookieHeader(page) {
  const cookies = await page.cookies();
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * 補助関数1: ページ全体をスクロールして、lazy-loading画像などを読み込むための関数
 * @param {Page} page - Puppeteer の page インスタンス
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

/**
 * 補助関数2: 次の問題への遷移をクリックする関数
 * @param {Object} page - Puppeteer の page オブジェクト
 * @param {number} [questionIndex=0] - エラーメッセージ用の問題番号（任意）
 */
async function clickNextQuestion(page, questionIndex = 0) {
  try {
    // ページ遷移後・スクロールして動的コンテンツ読み込み
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await autoScroll(page);
    await page.waitForSelector('div#answerCbtSection', { visible: true, timeout: 10000 });
    
    // 「次へ」ボタンを直接セレクタで取得してクリック
    await page.evaluate(() => {
      const nextBtn = document.querySelector('div#answerCbtSection > div.btn');
      if (nextBtn) {
        nextBtn.click();
      } else {
        throw new Error("次へボタンが見つかりませんでした");
      }
    });
    
    // クリック後、次の問題のコンテンツが表示されるのを待機
    await page.waitForSelector('div.question-content', { visible: true, timeout: 10000 });
  } catch (error) {
    console.error(`問題 ${questionIndex + 1}：次の問題へのクリックエラー:`, error);
  }
}

/**
 * 指定されたページ（ログイン済みの状態）から、連続して numPages 件の問題・解説データをスクレイピングする
 * @param {Page} page - Puppeteer の page インスタンス（ログイン後のもの）
 * @param {number} numPages - 取得する問題数
 * @returns {Promise<Array<Object>>} - 各問題・解説データの配列
 */
async function scrape(page, numPages) {
    const results = [];
    for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
      console.log(`--- 問題 ${pageIndex + 1} のスクレイピング開始 ---`);
  
      // ページ遷移後・スクロールして動的コンテンツ読み込み
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await autoScroll(page);
      await page.waitForSelector('div.header, [data-v-1e8b4a81].header', {
        visible: true,
        timeout: 10000,
      });
  
      // ① 「次へ」ボタンを3回クリックしてページを進める
      for (let j = 0; j < 3; j++) {
        await clickNextQuestion(page, j);
        // ページ遷移の安定のため少し待機
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
  
      // もう一度スクロールして動的コンテンツの読み込み
      await autoScroll(page);
      await page.waitForSelector('div#answerCbtSection', { visible: true, timeout: 10000 });
  
      // 「解答を確認する」ボタンをクリックして解説パートを表示
      try {
        await page.waitForSelector('div#answerCbtSection .btn', {
          visible: true,
          timeout: 5000,
        });
        // ボタン内のテキストが「解答を確認する」であることを確認
        const btnText = await page.evaluate(() => {
          const btn = document.querySelector('div#answerCbtSection .btn');
          return btn ? btn.innerText.trim() : "";
        });
        if (btnText.includes("解答を確認する")) {
          await page.click('div#answerCbtSection .btn');
        } else {
          throw new Error("解答を確認するボタンのテキストが一致しません: " + btnText);
        }
      } catch (error) {
        console.error(`問題 ${pageIndex + 1}：「解答を確認する」ボタンのクリックエラー:`, error);
      }
  
      // ③ 解説部が表示されるまで待機（より具体的な子要素で待機）
      await page.waitForSelector('div.questionResult .resultContent--currentCorrectAnswer', {
        visible: true,
        timeout: 15000,
      });
  
      console.log(`問題 ${pageIndex + 1} の解説が表示されました。`);
  
  
      // まず、ページ内のテキスト情報・画像URL等を取得
      const explanationData = await page.evaluate(() => {
        // KEYWORD の取得
        const sectionKeyword = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => el.querySelector(".descContent--title")?.innerText.trim() === "KEYWORD");
        let keyword = "";
        if (sectionKeyword) {
          const details = Array.from(sectionKeyword.querySelectorAll(".descContent--detail"));
          keyword = details.map(detail => detail.innerText.trim()).join("\n");
        }
  
        // 解法の要点の取得
        const sectionExplanationPoints = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => el.querySelector(".descContent--title")?.innerText.trim() === "解法の要点");
        let explanationPoints = "";
        if (sectionExplanationPoints) {
          const details = Array.from(sectionExplanationPoints.querySelectorAll(".descContent--detail"));
          explanationPoints = details.map(detail => detail.innerText.trim()).join("\n");
        }
  
        // 診断の取得
        const sectionDiagnosis = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => el.querySelector(".descContent--title")?.innerText.trim() === "診断");
        let diagnosis = "";
        if (sectionDiagnosis) {
          const details = Array.from(sectionDiagnosis.querySelectorAll(".descContent--detail"));
          diagnosis = details.map(detail => detail.innerText.trim()).join("\n");
        }
  
        // 選択肢解説の取得
        const sectionChoicesExplanation = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => el.querySelector(".descContent--title")?.innerText.trim() === "選択肢解説");
        let choicesExplanation = "";
        if (sectionChoicesExplanation) {
          const details = Array.from(sectionChoicesExplanation.querySelectorAll(".descContent--detail"));
          choicesExplanation = details.map(detail => detail.innerText.trim()).join("\n");
        }
  
        // ガイドラインの取得
        const sectionGuideline = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => el.querySelector(".descContent--title")?.innerText.trim() === "ガイドライン");
        let guideline = "";
        if (sectionGuideline) {
          const details = Array.from(sectionGuideline.querySelectorAll(".descContent--detail"));
          guideline = details.map(detail => detail.innerText.trim()).join("\n");
        }
  
  // 画像診断の抽出：画像URLとそのキャプション
  let explanationImages = [];
  let imageDiagnosisCaption = "";
  const imageBlock = Array.from(document.querySelectorAll('div.descContent'))
    .find(block => {
      const titleElem = block.querySelector('.descContent--title');
      return titleElem && titleElem.innerText.trim() === '画像診断';
    });
  if (imageBlock) {
    // まず、画像が存在するかチェック
    const imgElems = imageBlock.querySelectorAll('img');
    if (imgElems.length > 0) {
      // 画像があればURLを取得
      imgElems.forEach(img => {
        let src = img.getAttribute('src') || img.getAttribute('data-src') || "";
        if (src && src.trim() !== "") {
          explanationImages.push(src.trim());
        }
      });
      // キャプションの取得：優先的に div.figure 内の <p> 要素をチェック
      const captionElem = imageBlock.querySelector('div.figure p');
      if (captionElem) {
        imageDiagnosisCaption = captionElem.innerText.trim();
      }
    } else {
      // 画像が存在しない場合は、キャプションのみが存在するケースとする
      // 例として、descContent--detail 内のテキストから最初の [番号] 部分を除いた残りのテキストをキャプションとする
      const detailElem = imageBlock.querySelector('.descContent--detail');
      if (detailElem) {
        // detailElem 内のテキスト全体を取得
        let fullText = detailElem.innerText.trim();
        // 例: "[4-519(4/4)]" が先頭にある場合、これを除去する
        // 正規表現で角括弧内の数字や記号を除去
        imageDiagnosisCaption = fullText.replace(/^\[[^\]]*\]\s*/, "");
      }
    }
  }
        
        return {
          keyword,
          explanationPoints,
          diagnosis,
          choicesExplanation,
          guideline,
          explanationImages,
          imageDiagnosisCaption
        };
      });
  
    // Node 側で画像要素をキャプチャして Base64 に変換
    if (explanationData.explanationImages && explanationData.explanationImages.length > 0) {
        const processedExplanationImages = [];
        for (const src of explanationData.explanationImages) {
        if (src.startsWith("http")) {
            try {
            // まず、指定した画像要素が完全に読み込まれているか（complete かつ naturalWidth > 0）を待つ
            await page.waitForFunction(
                selector => {
                const img = document.querySelector(selector);
                return img && img.complete && img.naturalWidth > 0;
                },
                { timeout: 5000 },
                `img[src="${src}"]`
            );
            // その後、画像要素を取得してスクリーンショットを撮る
            const imageElement = await page.$(`img[src="${src}"]`);
            if (imageElement) {
                const screenshotData = await imageElement.screenshot({ encoding: 'base64' });
                processedExplanationImages.push(`data:image/png;base64,${screenshotData}`);
            } else {
                processedExplanationImages.push(src);
            }
            } catch (err) {
            console.error("解説画像キャプチャエラー:", src, err);
            processedExplanationImages.push(src);
            }
        } else {
            // 既に data URL の場合はそのまま
            processedExplanationImages.push(src);
        }
        }
        explanationData.explanationImages = processedExplanationImages;
    }
  
  
      // もしスクレイピング結果が全項目空なら、次の問題は存在しないと判断してループ終了
      if (
        !explanationData.keyword &&
        !explanationData.explanationPoints &&
        !explanationData.diagnosis &&
        !explanationData.choicesExplanation &&
        !explanationData.guideline &&
        (!explanationData.explanationImages || explanationData.explanationImages.length === 0)
      ) {
        break;
      }
  
      const problemData = {}; // ここでは空オブジェクトとする
      const combinedData = {
        problem: problemData,
        explanation: explanationData,
      };
  
      console.log(`問題 ${pageIndex + 1} のデータ:`, combinedData);
      results.push(combinedData);
  
      // 次の問題へ遷移するためのボタンをクリック
      try {
        await page.waitForSelector("div.toNextWrapper--btn", { visible: true, timeout: 10000 });
        await page.evaluate(() => {
          const btn = document.querySelector("div.toNextWrapper--btn");
          if (btn) btn.click();
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await page.waitForSelector("div.header, [data-v-1e8b4a81].header", {
          visible: true,
          timeout: 10000,
        });
      } catch (err) {
        console.error(`問題 ${pageIndex + 1}：次の問題への遷移エラー:`, err);
        break;
      }
    }
    return results;
  }
  

/**
 * 画像ソース（URLまたはBase64のdata URL）を受け取り、
 * URLの場合は axios で取得してBase64のdata URLに変換し、
 * 同時に画像サイズも取得して返します。
 * すでに data URL の場合は、Base64部分をデコードしてサイズを取得します。
 *
 * 戻り値は { dataUrl, dimensions } のオブジェクトです。
 *
 * @param {string} src - 画像の URL または data URL
 * @param {string} [cookieHeader] - オプションで axios のリクエストヘッダー用 Cookie 文字列
 */
async function processImage(src, cookieHeader) {
    if (src.startsWith('data:')) {
      try {
        // data URL の場合はそのまま変換
        const base64Data = src.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const dimensions = sizeOf(buffer);
        return { dataUrl: src, dimensions };
      } catch (error) {
        console.error("processImage(data URL) error:", error);
        return { dataUrl: src, dimensions: null };
      }
    } else {
      try {
        // node-fetch を使って画像データを取得する
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36',
          'Referer': 'https://cbt.medilink-study.com',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        };
        if (cookieHeader) {
          headers['Cookie'] = cookieHeader;
        }
  
        const response = await fetch(src, { headers });
        if (!response.ok) {
          console.error(`processImage: HTTP error ${response.status} for ${src}`);
          return { dataUrl: null, dimensions: null };
        }
        const contentType = response.headers.get('content-type');
        const buffer = await response.buffer();
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${contentType};base64,${base64}`;
        const dimensions = sizeOf(buffer);
        return { dataUrl, dimensions };
      } catch (error) {
        console.error("processImage(fetch) error:", error);
        return { dataUrl: null, dimensions: null };
      }
    }
  }

/**
 * PDF を生成する関数
 * @param {Array<Object>} contents - 各解説データの配列
 * @param {string} fileName - 生成するPDFのファイル名（拡張子は自動付与）
 * @param {string} cookieHeader - 画像取得時に使用する Cookie ヘッダー文字列
 */
async function generatePdf(contents, fileName, cookieHeader) {
  const documentDefinition = {
    content: [],
    defaultStyle: { font: 'NotoSansJP' },
    styles: {
      header: { fontSize: 12, bold: true, margin: [0, 0, 0, 10] },
      question: { fontSize: 12, margin: [0, 5, 0, 5] },
      choices: { fontSize: 12, margin: [15, 2, 0, 2] },
      explanationHeader: { fontSize: 12, bold: true, margin: [0, 15, 0, 5] },
      analysis: { fontSize: 10.5, margin: [15, 0, 0, 5] },
      keyword: { fontSize: 15, bold: true, margin: [0, 5, 0, 5] },
      points: { fontSize: 10.5, margin: [15, 0, 0, 15] },
      error: { fontSize: 10, color: 'red', margin: [0, 5, 0, 5] }
    }
  };

  // A4用紙の左右マージンを除いた利用可能横幅
  const availableWidth = 515.28;
  const maxAllowedWidth = availableWidth / 3; // 約171.76pt

  function getScaledWidth(obj) {
    if (obj && obj.dimensions && obj.dimensions.width) {
      return obj.dimensions.width > maxAllowedWidth ? maxAllowedWidth : obj.dimensions.width;
    }
    return maxAllowedWidth;
  }

  for (const content of contents) {
    // --- 【解説ページ】 ---
    documentDefinition.content.push({ text: "解説", style: 'explanationHeader' });

    // 画像診断の出力（画像とそのキャプション）
    if (content.explanationImageSrcs && content.explanationImageSrcs.length > 0) {
      const total = content.explanationImageSrcs.length;
      if (total === 1) {
        const processed = await processImage(content.explanationImageSrcs[0], cookieHeader);
        if (processed.dataUrl) {
          const scaledWidth = getScaledWidth(processed);
          documentDefinition.content.push({
            image: processed.dataUrl,
            width: scaledWidth,
            margin: [0, 5, 0, 5]
          });
        } else {
          documentDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
        }
      } else {
        const firstRowCount = Math.ceil(total / 2);
        let processedImages = [];
        for (let i = 0; i < total; i++) {
          const img = await processImage(content.explanationImageSrcs[i], cookieHeader);
          processedImages.push(img);
        }
        let tableBody = [];
        let row1 = [];
        for (let i = 0; i < firstRowCount; i++) {
          if (processedImages[i] && processedImages[i].dataUrl) {
            row1.push({ image: processedImages[i].dataUrl, width: getScaledWidth(processedImages[i]) });
          } else {
            row1.push({ text: "解説画像読み込みエラー", style: 'error' });
          }
        }
        tableBody.push(row1);
        if (total > firstRowCount) {
          let row2 = [];
          for (let i = firstRowCount; i < total; i++) {
            if (processedImages[i] && processedImages[i].dataUrl) {
              row2.push({ image: processedImages[i].dataUrl, width: getScaledWidth(processedImages[i]) });
            } else {
              row2.push({ text: "解説画像読み込みエラー", style: 'error' });
            }
          }
          while (row2.length < firstRowCount) {
            row2.push({ text: "" });
          }
          tableBody.push(row2);
        }
        documentDefinition.content.push({
          table: {
            widths: tableBody[0].map(() => '*'),
            body: tableBody
          },
          layout: 'noBorders',
          margin: [0, 5, 0, 5]
        });
      }
      // 画像診断キャプションが存在する場合、画像の下に出力
      if (content.imageDiagnosisCaption && content.imageDiagnosisCaption.trim() !== "") {
        documentDefinition.content.push({
          text: content.imageDiagnosisCaption,
          style: 'analysis',
          margin: [0, 5, 0, 5]
        });
      }
    }

    // その他の解説テキスト群の出力
    documentDefinition.content.push({ text: "KEYWORD", style: 'explanationHeader' });
    documentDefinition.content.push({ text: content.keyword, style: 'analysis' });
    documentDefinition.content.push({ text: "解法の要点", style: 'explanationHeader' });
    documentDefinition.content.push({ text: content.explanationPoints, style: 'analysis' });
    documentDefinition.content.push({ text: "診断", style: 'explanationHeader' });
    documentDefinition.content.push({ text: content.diagnosis, style: 'analysis' });
    documentDefinition.content.push({ text: "選択肢解説", style: 'explanationHeader' });
    documentDefinition.content.push({ text: content.choicesExplanation, style: 'analysis' });
    documentDefinition.content.push({ text: "ガイドライン", style: 'explanationHeader' });
    documentDefinition.content.push({ text: content.guideline, style: 'analysis' });
    // 改ページ（解説ページ終了）
    documentDefinition.content.push({ text: '', pageBreak: 'after' });
  }

  try {
    const extension = "pdf";
    const pdfDoc = pdfMake.createPdf(documentDefinition);
    pdfDoc.getBuffer((buffer) => {
      fs.writeFileSync(`${fileName}.${extension}`, buffer);
      console.log("PDFファイルが生成されました。");
    });
  } catch (error) {
    console.error("PDF生成エラー:", error);
  }
}

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // ログイン情報・URL
  const loginUrl = 'https://login.medilink-study.com/login';
  const email = '';
  const password = '';
  const startUrl = 'https://cbt.medilink-study.com/Answer/2009400360';
  const fileName = "4連問解答";
  const numberOfPages = 120;

  try {
    // ① ログイン処理
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="username"]', { visible: true });
    await page.type('input[name="username"]', email, { delay: 100 });
    await page.waitForSelector('input[name="password"]', { visible: true });
    await page.type('input[name="password"]', password, { delay: 100 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('button[type="submit"]')
    ]);

    // ② 最初の問題ページへ移動
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    // 問題と解説のスクレイピング
    const explanationDataArray = await scrape(page, numberOfPages);

    // PDF生成のため、再度最新の Cookie 情報を取得
    const cookieHeader = await getCookieHeader(page);

    // PDF生成のため、各解説データを contents 配列に整形
    const contents = explanationDataArray.map(data => ({
      keyword: data.explanation.keyword,
      explanationPoints: data.explanation.explanationPoints,
      diagnosis: data.explanation.diagnosis,
      choicesExplanation: data.explanation.choicesExplanation,
      guideline: data.explanation.guideline,
      explanationImageSrcs: data.explanation.explanationImages,
      imageDiagnosisCaption: data.explanation.imageDiagnosisCaption
    }));
      
    // PDF生成
    await generatePdf(contents, fileName, cookieHeader);
  } catch (error) {
    console.error('エラー:', error);
  } finally {
    await browser.close();
  }
}

main();
