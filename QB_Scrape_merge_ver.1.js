const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const pdfMake = require('pdfmake/build/pdfmake');
const vfsFonts = require('./build/vfs_fonts.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sizeOf = require('image-size');
const { PDFDocument } = require('pdf-lib');

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
 * 画像の URL または data URL を受け取り、Base64のdata URL と画像サイズを返す関数
 */
async function processImage(src, cookieHeader) {
  if (src.startsWith('data:')) {
    try {
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
 * Puppeteer のページから Cookie 情報を取得し、
 * "name1=value1; name2=value2; ..." の形式に整形する関数
 */
async function getCookieHeader(page) {
  const cookies = await page.cookies();
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * ページ全体をスクロールして lazy-loading 画像などを読み込むための関数
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
 * 次の問題への遷移をクリックする関数
 */
async function clickNextQuestion(page, questionIndex = 0) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await autoScroll(page);
    await page.waitForSelector('div#answerCbtSection', { visible: true, timeout: 10000 });
    await page.evaluate(() => {
      const nextBtn = document.querySelector('div#answerCbtSection > div.btn');
      if (nextBtn) {
        nextBtn.click();
      } else {
        throw new Error("次へボタンが見つかりませんでした");
      }
    });
    await page.waitForSelector('div.question-content', { visible: true, timeout: 10000 });
  } catch (error) {
    console.error(`問題 ${questionIndex + 1}：次の問題へのクリックエラー:`, error);
  }
}

/**
 * スクレイピング処理：指定されたページから numPages 件の問題・解説データを取得する
 */
async function scrape(page, numPages) {
  const results = [];
  for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
    console.log(`--- 問題 ${pageIndex + 1} のスクレイピング開始 ---`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await autoScroll(page);
    await page.waitForSelector('div.header, [data-v-1e8b4a81].header', { visible: true, timeout: 10000 });

    for (let j = 0; j < 3; j++) {
      await clickNextQuestion(page, j);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await autoScroll(page);
    await page.waitForSelector('div#answerCbtSection', { visible: true, timeout: 10000 });

    try {
      await page.waitForSelector('div#answerCbtSection .btn', { visible: true, timeout: 5000 });
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

    await page.waitForSelector('div.questionResult .resultContent--currentCorrectAnswer', {
      visible: true,
      timeout: 15000,
    });

    console.log(`問題 ${pageIndex + 1} の解説が表示されました。`);

    const explanationData = await page.evaluate(() => {
      // 各セクションのテキストを取得するヘルパー
      const getSectionText = title => {
        const section = Array.from(document.querySelectorAll("div.descContent"))
          .find(el => {
            const titleElem = el.querySelector(".descContent--title");
            return titleElem && titleElem.innerText.trim() === title;
          });
        if (section) {
          const details = Array.from(section.querySelectorAll(".descContent--detail"));
          return details.map(detail => detail.innerText.trim()).join("\n");
        }
        return "";
      };

      const keyword = getSectionText("KEYWORD");
      const explanationPoints = getSectionText("解法の要点");
      const diagnosis = getSectionText("診断");
      const choicesExplanation = getSectionText("選択肢解説");
      const guideline = getSectionText("ガイドライン");

      // 画像診断の抽出：画像URLとそのキャプション
      let explanationImages = [];
      let imageDiagnosisCaption = "";
      const imageBlock = Array.from(document.querySelectorAll('div.descContent'))
        .find(block => {
          const titleElem = block.querySelector('.descContent--title');
          return titleElem && titleElem.innerText.trim() === '画像診断';
        });
      if (imageBlock) {
        const imgElems = imageBlock.querySelectorAll('img');
        if (imgElems.length > 0) {
          imgElems.forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || "";
            if (src.trim() !== "") {
              explanationImages.push(src.trim());
            }
          });
          const captionElem = imageBlock.querySelector('div.figure p');
          if (captionElem) {
            imageDiagnosisCaption = captionElem.innerText.trim();
          }
        } else {
          // 画像が存在しない場合：descContent--detail からキャプションを抽出
          const detailElem = imageBlock.querySelector('.descContent--detail');
          if (detailElem) {
            let fullText = detailElem.innerText.trim();
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

    // 画像についてのキャプチャ処理（必要なら）
    if (explanationData.explanationImages && explanationData.explanationImages.length > 0) {
      const processedExplanationImages = [];
      for (const src of explanationData.explanationImages) {
        if (src.startsWith("http")) {
          try {
            await page.waitForFunction(
              selector => {
                const img = document.querySelector(selector);
                return img && img.complete && img.naturalWidth > 0;
              },
              { timeout: 5000 },
              `img[src="${src}"]`
            );
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
          processedExplanationImages.push(src);
        }
      }
      explanationData.explanationImages = processedExplanationImages;
    }

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

    const problemData = {}; // 必要に応じて問題文なども追加
    const combinedData = {
      problem: problemData,
      explanation: explanationData,
    };

    console.log(`問題 ${pageIndex + 1} のデータ:`, combinedData);
    results.push(combinedData);

    try {
      await page.waitForSelector("div.toNextWrapper--btn", { visible: true, timeout: 10000 });
      await page.evaluate(() => {
        const btn = document.querySelector("div.toNextWrapper--btn");
        if (btn) btn.click();
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await page.waitForSelector("div.header, [data-v-1e8b4a81].header", { visible: true, timeout: 10000 });
    } catch (err) {
      console.error(`問題 ${pageIndex + 1}：次の問題への遷移エラー:`, err);
      break;
    }
  }
  return results;
}

/**
 * 各問題の解説データ（1問分の content オブジェクト）から、pdfMake を使ってその問題の解説PDF（バッファ）を生成する関数
 */
async function generateSingleQuestionPdfBuffer(content, cookieHeader) {
  // 最大横幅の設定（例として 171.76pt）
  function getScaledWidth(obj) {
    const maxAllowedWidth = 171.76;
    if (obj && obj.dimensions && obj.dimensions.width) {
      return obj.dimensions.width > maxAllowedWidth ? maxAllowedWidth : obj.dimensions.width;
    }
    return maxAllowedWidth;
  }

  const docDefinition = {
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

  // 解説タイトル
  docDefinition.content.push({ text: "解説", style: 'explanationHeader' });
  // 画像診断セクション タイトル
  docDefinition.content.push({ text: "画像診断", style: 'explanationHeader' });

  // 画像診断の出力（画像とそのキャプション）
  if (content.explanationImages && content.explanationImages.length > 0) {
    const total = content.explanationImages.length;
    if (total === 1) {
      const processed = await processImage(content.explanationImages[0], cookieHeader);
      if (processed.dataUrl) {
        const scaledWidth = getScaledWidth(processed);
        docDefinition.content.push({
          image: processed.dataUrl,
          width: scaledWidth,
          margin: [0, 5, 0, 5]
        });
      } else {
        docDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
      }
    } else {
      const firstRowCount = Math.ceil(total / 2);
      let processedImages = [];
      for (let i = 0; i < total; i++) {
        const img = await processImage(content.explanationImages[i], cookieHeader);
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
      docDefinition.content.push({
        table: {
          widths: tableBody[0].map(() => '*'),
          body: tableBody
        },
        layout: 'noBorders',
        margin: [0, 5, 0, 5]
      });
    }

    
  }
  docDefinition.content.push({ text: content.imageDiagnosisCaption, style: 'analysis', margin: [0, 5, 0, 5] });

  docDefinition.content.push({ text: "KEYWORD", style: 'explanationHeader' });
  docDefinition.content.push({ text: content.keyword, style: 'analysis' });
  docDefinition.content.push({ text: "解法の要点", style: 'explanationHeader' });
  docDefinition.content.push({ text: content.explanationPoints, style: 'analysis' });
  docDefinition.content.push({ text: "診断", style: 'explanationHeader' });
  docDefinition.content.push({ text: content.diagnosis, style: 'analysis' });
  docDefinition.content.push({ text: "選択肢解説", style: 'explanationHeader' });
  docDefinition.content.push({ text: content.choicesExplanation, style: 'analysis' });
  docDefinition.content.push({ text: "ガイドライン", style: 'explanationHeader' });
  docDefinition.content.push({ text: content.guideline, style: 'analysis' });

  return new Promise((resolve, reject) => {
    pdfMake.createPdf(docDefinition).getBuffer(buffer => {
      resolve(buffer);
    });
  });
}

/**
 * 4B.pdf（ベースPDF）と各問題ごとの解説PDF（スクレイピング結果）を交互に差し込み、1つのPDFを生成する関数
 * ※4B.pdf は1問につき4ページのグループとなっている前提
 */
async function mergeScrapedWithBase(contents, basePdfPath, outputPdfPath, cookieHeader) {
  const basePdfBytes = fs.readFileSync(basePdfPath);
  const basePdfDoc = await PDFDocument.load(basePdfBytes);
  const mergedPdf = await PDFDocument.create();
  const numQuestions = contents.length;
  const basePageCount = basePdfDoc.getPageCount();

  for (let i = 0; i < numQuestions; i++) {
    // 4B.pdf の該当グループ（1問につき4ページ）を追加
    for (let j = 0; j < 4; j++) {
      const pageIndex = i * 4 + j;
      if (pageIndex < basePageCount) {
        const [copiedPage] = await mergedPdf.copyPages(basePdfDoc, [pageIndex]);
        mergedPdf.addPage(copiedPage);
      }
    }
    // 各問題ごとのスクレイピング結果PDFを生成
    const buffer = await generateSingleQuestionPdfBuffer(contents[i].explanation, cookieHeader);
    const scrapedPdfDoc = await PDFDocument.load(buffer);
    const scrapedPageCount = scrapedPdfDoc.getPageCount();
    for (let k = 0; k < scrapedPageCount; k++) {
      const [copiedScrapedPage] = await mergedPdf.copyPages(scrapedPdfDoc, [k]);
      mergedPdf.addPage(copiedScrapedPage);
    }
  }

  const mergedPdfBytes = await mergedPdf.save();
  fs.writeFileSync(outputPdfPath, mergedPdfBytes);
  console.log(`Merged PDF saved as: ${outputPdfPath}`);
}

async function generatePdf(contents, fileName, cookieHeader) {
  // mergeScrapedWithBase で各問題ごとのPDFと4B.pdfをマージする
  await mergeScrapedWithBase(contents, '4B.pdf', `${fileName}_merged.pdf`, cookieHeader);
}

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // ログイン情報・URL
  const loginUrl = 'https://login.medilink-study.com/login';
  const email = '';
  const password = '';
  const startUrl = 'https://cbt.medilink-study.com/Answer/2009400360';
  const fileName = "4連問";
  const numberOfPages = 120;

  try {
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="username"]', { visible: true });
    await page.type('input[name="username"]', email, { delay: 100 });
    await page.waitForSelector('input[name="password"]', { visible: true });
    await page.type('input[name="password"]', password, { delay: 100 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('button[type="submit"]')
    ]);

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    const explanationDataArray = await scrape(page, numberOfPages);
    const cookieHeader = await getCookieHeader(page);
    const contents = explanationDataArray.map(data => ({
      explanation: data.explanation
    }));

    await generatePdf(contents, fileName, cookieHeader);
  } catch (error) {
    console.error('エラー:', error);
  } finally {
    await browser.close();
  }
}

main();
