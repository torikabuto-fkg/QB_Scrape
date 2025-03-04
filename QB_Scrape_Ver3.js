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
 * ページ全体をスクロールして、lazy-loading画像などを読み込むための関数
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
 * 指定されたページ（ログイン済みの状態）から、連続して numPages 件の問題・解説データをスクレイピングする
 * ※ 基本事項（div.basic）の内容を、タイトル、詳細テキスト、画像 URL として抽出
 */
async function scrapeQuestions(page, numPages) {
  const results = [];

  for (let i = 0; i < numPages; i++) {
    console.log(`--- 問題 ${i + 1} のスクレイピング開始 ---`);

    // ページ遷移後・スクロールして動的コンテンツ読み込み
    await new Promise(resolve => setTimeout(resolve, 10000));
    await autoScroll(page);
    await page.waitForSelector('div.header, [data-v-1e8b4a81].header', { visible: true, timeout: 10000 });

    // ① ヘッダー（問題番号）の取得
    const headerData = await page.evaluate(() => {
      let problemNumber = '';
      const headerElem = document.querySelector('div.header') || document.querySelector('[data-v-1e8b4a81].header');
      if (headerElem) {
        problemNumber = headerElem.querySelector('span')?.innerText.trim() || '';
      }
      return { problemNumber };
    });

    // ② 問題文の取得（retry を使用）
    let questionText = "";
    const maxRetries = 120;
    let retries = 0;
    while (retries < maxRetries && questionText.trim() === "") {
      questionText = await page.evaluate(() => {
        const qc = document.querySelector('div.question-content') ||
                   document.querySelector('[data-v-3fb3fcc8] .question-content');
        if (qc) {
          const pElem = qc.querySelector('.body p');
          return pElem ? pElem.innerText.trim() : "";
        }
        return "";
      });
      if (questionText.trim() !== "") break;
      await new Promise(resolve => setTimeout(resolve, 500));
      retries++;
    }
    if (questionText.trim() === "") {
      console.warn(`問題 ${i + 1} の問題文が取得できませんでした。`);
      questionText = "【問題文なし】";
    }

    // ③ 問題画像の取得（URL文字列として取得）
    let problemImageSrcs = await page.evaluate(() => {
      const qc = document.querySelector('div.question-content') ||
                 document.querySelector('[data-v-3fb3fcc8] .question-content');
      let images = [];
      if (qc) {
        const imgElems = qc.querySelectorAll('div.figure img');
        imgElems.forEach(img => {
          let src = img.getAttribute('src') || img.getAttribute('data-src') || "";
          if (src && src.trim() !== "") {
            images.push(src.trim());
          }
        });
      }
      return images;
    });

    // ③-2 問題画像のURLがある場合は、対象画像要素をキャプチャーして Base64 に変換
    const processedProblemImages = [];
    for (const src of problemImageSrcs) {
      if (src.startsWith('http')) {
        try {
          const imageElement = await page.$(`img[src="${src}"]`);
          if (imageElement) {
            const screenshotData = await imageElement.screenshot({ encoding: 'base64' });
            processedProblemImages.push(`data:image/png;base64,${screenshotData}`);
          } else {
            processedProblemImages.push(src);
          }
        } catch (err) {
          console.error("問題画像キャプチャエラー:", src, err);
          processedProblemImages.push(src);
        }
      } else {
        processedProblemImages.push(src);
      }
    }

    // ④ 選択肢の取得（重複除外）
    const choicesRaw = await page.evaluate(() => {
      let arr = [];
      const elems = document.querySelectorAll('ul.multiple-answer-options li div.ans');
      elems.forEach(el => {
        const txt = el.innerText.trim();
        if (txt) arr.push(txt);
      });
      return arr;
    });
    const choices = [...new Set(choicesRaw)];

    // ⑤ 問題IDの取得
    const problemId = await page.evaluate(() => {
      let id = '';
      const footerElem = document.querySelector('div.question-footer');
      if (footerElem) {
        const m = footerElem.innerText.match(/ID\s*:\s*(\d+)/);
        if (m && m[1]) {
          id = m[1];
        }
      }
      return id;
    });

    // 統合：問題データの作成
    const problemData = {
      problemNumber: headerData.problemNumber,
      questionText: questionText,
      problemImageSrcs: processedProblemImages,
      problemId: problemId,
      choices: choices
    };

    // ⑥ 「解答を確認する」ボタンをクリックして解説パートを表示
    try {
      await page.waitForSelector('div#answerCbtSection div.btn', { visible: true, timeout: 5000 });
      await page.evaluate(() => {
        const btn = document.querySelector('div#answerCbtSection div.btn');
        if (btn) btn.click();
      });
    } catch (error) {
      console.error(`問題 ${i + 1}：「解答を確認する」ボタンのクリックエラー:`, error);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await page.waitForSelector('div.resultContent--currentCorrect', { visible: true, timeout: 10000 });
    } catch (e) {
      console.error(`問題 ${i + 1}：正解表示が現れませんでした:`, e);
      try {
        await page.evaluate(() => {
          const btn = document.querySelector('div.toNextWrapper--btn');
          if (btn) btn.click();
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error(`問題 ${i + 1}：次の問題への遷移エラー:`, err);
      }
      continue;
    }

    // ⑦ 【解説部分】の取得
    let explanationData = await page.evaluate(() => {
      let correctAnswer = '';
      const correctElem = document.querySelector('div.resultContent--currentCorrect span.resultContent--currentCorrectAnswer');
      if (correctElem) {
        correctAnswer = correctElem.innerText.trim();
      }
      let explanationPoints = '';
      const pointsBlock = Array.from(document.querySelectorAll('div.descContent')).find(block => {
        const title = block.querySelector('.descContent--title')?.innerText.trim() || '';
        return title === '解法の要点';
      });
      if (pointsBlock) {
        explanationPoints = pointsBlock.querySelector('.descContent--detail')?.innerText.trim() || '';
      } else {
        explanationPoints = "解法の要点なし";
      }
      let optionAnalysis = '';
      const optionBlock = Array.from(document.querySelectorAll('div.descContent')).find(block => {
        const title = block.querySelector('.descContent--title')?.innerText.trim() || '';
        return title === '選択肢解説';
      });
      if (optionBlock) {
        optionAnalysis = optionBlock.querySelector('.descContent--detail')?.innerText.trim() || '';
      }
      let guideline = '';
      const guidelineBlock = Array.from(document.querySelectorAll('div.descContent')).find(block => {
        const title = block.querySelector('.descContent--title')?.innerText.trim() || '';
        return title === 'ガイドライン';
      });
      if (guidelineBlock) {
        guideline = guidelineBlock.querySelector('.descContent--detail')?.innerText.trim() || '';
      }
      // 解説画像の取得
      let explanationImages = [];
      const imageBlock = Array.from(document.querySelectorAll('div.descContent')).find(block => {
        const title = block.querySelector('.descContent--title')?.innerText.trim() || '';
        return title === '画像診断';
      });
      if (imageBlock) {
        const imgElems = imageBlock.querySelectorAll('div.figure img, img');
        imgElems.forEach(img => {
          let src = img.getAttribute('src') || img.getAttribute('data-src') || "";
          if (src && src.trim() !== "") {
            explanationImages.push(src.trim());
          }
        });
      }
      return { correctAnswer, explanationPoints, optionAnalysis, guideline, explanationImages };
    });

    // ⑦-2 解説画像のURLがある場合はキャプチャーして Base64 に変換
    if (explanationData.explanationImages && explanationData.explanationImages.length > 0) {
      const processedExplanationImages = [];
      for (const src of explanationData.explanationImages) {
        if (src.startsWith('http')) {
          try {
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

    // --- 追加：基本事項などの取得 ---
    // ページに「div.basic」が存在すれば、タイトル、テキスト、かつ内部の画像 URL を毎回抽出する
    const basicData = await page.evaluate(() => {
      const basicElem = document.querySelector('div.basic');
      if (basicElem) {
        const title = basicElem.querySelector('.basic--title span')?.innerText.trim() || '';
        const contentElem = basicElem.querySelector('.basicsContent--detail');
        const textContent = contentElem ? contentElem.innerText.trim() : '';
        let images = [];
        if (contentElem) {
          const imgElems = contentElem.querySelectorAll('img');
          imgElems.forEach(img => {
            let src = img.getAttribute('src') || "";
            if (src && src.trim() !== "") {
              images.push(src.trim());
            }
          });
        }
        return { title, textContent, images };
      }
      return null;
    });
    // 基本事項画像のURLがある場合はキャプチャーして Base64 に変換
    if (basicData && basicData.images && basicData.images.length > 0) {
      const processedBasicImages = [];
      for (const src of basicData.images) {
        if (src.startsWith('http')) {
          try {
            const imageElement = await page.$(`img[src="${src}"]`);
            if (imageElement) {
              const screenshotData = await imageElement.screenshot({ encoding: 'base64' });
              processedBasicImages.push(`data:image/png;base64,${screenshotData}`);
            } else {
              processedBasicImages.push(src);
            }
          } catch (err) {
            console.error("基本事項画像キャプチャエラー:", src, err);
            processedBasicImages.push(src);
          }
        } else {
          processedBasicImages.push(src);
        }
      }
      basicData.images = processedBasicImages;
    }
    // 更新（または保持）する globalBasicData（必要に応じて）
    if (basicData) {
      globalBasicData = basicData;
    }

    const combinedData = {
      problem: problemData,
      explanation: explanationData,
      basic: basicData  // 各ページでスクレイピングした基本事項を格納
    };

    console.log(`問題 ${i + 1} のデータ:`, combinedData);
    results.push(combinedData);

    // ⑨ 「次の問題へ」ボタンをクリックして次ページへ遷移
    try {
      await page.waitForSelector('div.toNextWrapper--btn', { visible: true, timeout: 10000 });
      await page.evaluate(() => {
        const btn = document.querySelector('div.toNextWrapper--btn');
        if (btn) btn.click();
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      await page.waitForSelector('div.header, [data-v-1e8b4a81].header', { visible: true, timeout: 10000 });
    } catch (err) {
      console.error(`問題 ${i + 1}：次の問題への遷移エラー:`, err);
      break;
    }
  }

  return { results};
}


/**
 * 画像ソース（URLまたはBase64のdata URL）を受け取り、URLの場合はaxiosで取得してBase64のdata URLに変換し、同時に画像サイズも取得して返す
 * 戻り値は { dataUrl, dimensions } のオブジェクト
 */
async function processImage(src) {
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
      const response = await axios.get(src, { responseType: 'arraybuffer' });
      if (response.status === 200) {
        const contentType = response.headers['content-type'];
        const buffer = Buffer.from(response.data, 'binary');
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${contentType};base64,${base64}`;
        const dimensions = sizeOf(buffer);
        return { dataUrl, dimensions };
      } else {
        return { dataUrl: null, dimensions: null };
      }
    } catch (error) {
      console.error("processImage(URL) error:", error);
      return { dataUrl: null, dimensions: null };
    }
  }
}

/**
 * PDF生成関数
 * contents は各問題・解説データの配列（problem, explanation）
 * globalBasicData は基本事項のデータ（タイトル、テキスト、images）であり、解説と同じページに掲載する
 *
 * ※ 画像はA4用紙の利用可能横幅（515.28pt）を3分割した幅以内に縮小する
 */
async function generatePdf(contents, fileName) {
  const documentDefinition = {
    content: [],
    defaultStyle: { font: 'NotoSansJP' },
    styles: {
      header: { fontSize: 12, bold: true, margin: [0, 0, 0, 10] },
      question: { fontSize: 10.5, margin: [0, 5, 0, 5] },
      choices: { fontSize: 10.5, margin: [15, 2, 0, 2] },
      explanationHeader: { fontSize: 12, bold: true, margin: [0, 15, 0, 5] },
      analysis: { fontSize: 10.5, margin: [15, 0, 0, 5] },
      correctAnswer: { fontSize: 12, bold: true, margin: [0, 5, 0, 5] },
      points: { fontSize: 10.5, margin: [15, 0, 0, 15] },
      error: { fontSize: 10.5, color: 'red', margin: [0, 5, 0, 5] }
    }
  };

  const availableWidth = 515.28;
  const maxAllowedWidth = availableWidth / 3; // 約171.76pt

  function getScaledWidth(obj) {
    if (obj && obj.dimensions && obj.dimensions.width) {
      return obj.dimensions.width > maxAllowedWidth ? maxAllowedWidth : obj.dimensions.width;
    }
    return maxAllowedWidth;
  }

  let index = 0;
  for (const content of contents) {
    index++;
    // --- 【問題ページ】 ---
    documentDefinition.content.push(
      { text: `問題番号: ${content.problem.problemNumber}`, style: 'header' },
      { text: `問題ID: ${content.problem.problemId}`, style: 'header' },
      { text: content.problem.questionText, style: 'question' }
    );

    // ◆ 問題画像の追加（既存処理）
    if (content.problem.problemImageSrcs && content.problem.problemImageSrcs.length > 0) {
      const total = content.problem.problemImageSrcs.length;
      if (total === 1) {
        const processed = await processImage(content.problem.problemImageSrcs[0]);
        if (processed.dataUrl) {
          const scaledWidth = getScaledWidth(processed);
          documentDefinition.content.push({
            image: processed.dataUrl,
            width: scaledWidth,
            margin: [0, 5, 0, 5]
          });
        } else {
          documentDefinition.content.push({ text: "問題画像読み込みエラー", style: 'error' });
        }
      } else {
        const firstRowCount = Math.ceil(total / 2);
        const secondRowCount = total - firstRowCount;
        let processedImages = [];
        for (let i = 0; i < total; i++) {
          const img = await processImage(content.problem.problemImageSrcs[i]);
          processedImages.push(img);
        }
        let tableBody = [];
        let row1 = [];
        for (let i = 0; i < firstRowCount; i++) {
          if (processedImages[i] && processedImages[i].dataUrl) {
            row1.push({ image: processedImages[i].dataUrl, width: getScaledWidth(processedImages[i]) });
          } else {
            row1.push({ text: "問題画像読み込みエラー", style: 'error' });
          }
        }
        tableBody.push(row1);
        if (secondRowCount > 0) {
          let row2 = [];
          for (let i = firstRowCount; i < total; i++) {
            if (processedImages[i] && processedImages[i].dataUrl) {
              row2.push({ image: processedImages[i].dataUrl, width: getScaledWidth(processedImages[i]) });
            } else {
              row2.push({ text: "問題画像読み込みエラー", style: 'error' });
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
    }

    // 選択肢の追加
    if (content.problem.choices && content.problem.choices.length > 0) {
      documentDefinition.content.push({
        ul: content.problem.choices,
        style: 'choices'
      });
    }
    // ページ改行（問題ページ終了）
    documentDefinition.content.push({ text: '', pageBreak: 'after' });

    // --- 【解説ページ】 ---
    if (content.explanation) {
      documentDefinition.content.push({ text: "解説", style: 'explanationHeader' });

      // ◆ 解説画像の追加（既存処理）
      if (content.explanation.explanationImageSrcs && content.explanation.explanationImageSrcs.length > 0) {
        const total = content.explanation.explanationImageSrcs.length;
        if (total === 1) {
          const processed = await processImage(content.explanation.explanationImageSrcs[0]);
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
          const secondRowCount = total - firstRowCount;
          let processedImages = [];
          for (let i = 0; i < total; i++) {
            const img = await processImage(content.explanation.explanationImageSrcs[i]);
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
          if (secondRowCount > 0) {
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
      }

      // 解説テキスト群
      documentDefinition.content.push({ text: "解法の要点", style: 'explanationHeader' });
      documentDefinition.content.push({ text: content.explanation.explanationPoints, style: 'analysis' });
      documentDefinition.content.push({ text: "選択肢解説", style: 'explanationHeader' });
      documentDefinition.content.push({ text: content.explanation.optionAnalysis, style: 'analysis' });
      if (content.explanation.correctAnswer && content.explanation.correctAnswer.trim() !== '') {
        documentDefinition.content.push({ text: "正解", style: 'explanationHeader' });
        documentDefinition.content.push({ text: content.explanation.correctAnswer, style: 'correctAnswer' });
      }
      documentDefinition.content.push({ text: "ガイドライン", style: 'explanationHeader' });
      documentDefinition.content.push({ text: content.explanation.guideline, style: 'analysis' });

    // --- ここで【基本事項】を解説と同じページに挿入 ---
    if (content.basic) {
      documentDefinition.content.push({ text: content.basic.title || "基本事項など", style: 'explanationHeader' });
      documentDefinition.content.push({ text: content.basic.textContent, style: 'analysis' });
      if (content.basic.images && content.basic.images.length > 0) {
        const totalBasic = content.basic.images.length;
        if (totalBasic === 1) {
          const processedBasic = await processImage(content.basic.images[0]);
          if (processedBasic.dataUrl) {
            const scaledWidth = getScaledWidth(processedBasic);
            documentDefinition.content.push({
              image: processedBasic.dataUrl,
              width: scaledWidth,
              margin: [0, 5, 0, 5]
            });
          } else {
            documentDefinition.content.push({ text: "基本事項画像読み込みエラー", style: 'error' });
          }
        } else {
          let processedBasicImages = [];
          for (let j = 0; j < totalBasic; j++) {
            const img = await processImage(content.basic.images[j]);
            processedBasicImages.push(img);
          }
          const firstRowCount = Math.ceil(totalBasic / 2);
          const secondRowCount = totalBasic - firstRowCount;
          let tableBody = [];
          let row1 = [];
          for (let j = 0; j < firstRowCount; j++) {
            if (processedBasicImages[j] && processedBasicImages[j].dataUrl) {
              row1.push({ image: processedBasicImages[j].dataUrl, width: getScaledWidth(processedBasicImages[j]) });
            } else {
              row1.push({ text: "基本事項画像読み込みエラー", style: 'error' });
            }
          }
          tableBody.push(row1);
          if (secondRowCount > 0) {
            let row2 = [];
            for (let j = firstRowCount; j < totalBasic; j++) {
              if (processedBasicImages[j] && processedBasicImages[j].dataUrl) {
                row2.push({ image: processedBasicImages[j].dataUrl, width: getScaledWidth(processedBasicImages[j]) });
              } else {
                row2.push({ text: "基本事項画像読み込みエラー", style: 'error' });
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
      }
    }
    // 改ページ（解説ページ終了）
    documentDefinition.content.push({ text: '', pageBreak: 'after' });
    }
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

  const loginUrl = 'https://login.medilink-study.com/login'; // ログインURL
  const email = ' ';           // ログイン用メール
  const password = ' ';                 // ログイン用パスワード
  const fileName = "1H 免疫";                  // 保存するPDFのファイル名
  const startUrl = 'https://cbt.medilink-study.com/Answer/2014100430'; // 最初の問題ページ
  const numberOfPages = 59;                          // 取得する問題数 

  // ログイン処理
  await page.goto(loginUrl);
  await page.type('input[name="username"]', email);
  await page.type('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  // 最初の問題ページへ移動
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  // 問題と解説のスクレイピング
  const {results} = await scrapeQuestions(page, numberOfPages);

  // PDF生成（基本事項なども含む）
  await generatePdf(results, fileName);

  await browser.close();
}

main().catch((error) => console.error('エラー:', error));