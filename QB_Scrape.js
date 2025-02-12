const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const pdfMake = require('pdfmake/build/pdfmake');
const vfsFonts = require('./build/vfs_fonts.js');
const fs = require('fs');
const path = require('path');

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
 * @param {Page} page - Puppeteer の page インスタンス（ログイン後のもの）
 * @param {number} numPages - 取得する問題数
 * @returns {Promise<Array<Object>>} - 各問題・解説データの配列
 */
async function scrapeQuestions(page, numPages) {
  const results = [];

  for (let i = 0; i < numPages; i++) {
    console.log(`--- 問題 ${i + 1} のスクレイピング開始 ---`);

    // ページ遷移後、動的コンテンツが読み込まれるのを期待して少し待機
    await new Promise(resolve => setTimeout(resolve, 3000));
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

    // ② 問題文（questionText）の取得（選択肢と混在しないように、.body p 要素のみ取得）
    let questionText = "";
    const maxRetries = 60; // 最大60回（500ms×60=30秒）
    let retries = 0;
    while (retries < maxRetries && questionText.trim() === "") {
      questionText = await page.evaluate(() => {
        const qc = document.querySelector('div.question-content') ||
                  document.querySelector('[data-v-3fb3fcc8] .question-content');
        if (qc) {
          // .body p のテキストのみを取得する
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

    // ③ 問題画像の取得（「div.figure」内の img 要素から取得）
    const problemImageSrcs = await page.evaluate(() => {
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
    const choices = [...new Set(choicesRaw)]; // 重複を除外

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

    // 統合
    const problemData = {
      problemNumber: headerData.problemNumber,
      questionText: questionText,
      problemImageSrcs: problemImageSrcs,
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

    // 少し待機
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await page.waitForSelector('div.resultContent--currentCorrect', { visible: true, timeout: 10000 });
    } catch (e) {
      console.error(`問題 ${i + 1}：正解表示が現れませんでした:`, e);
      // 次ページへ進む処理（エラー時）
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
    const explanationData = await page.evaluate(() => {
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

      // 画像診断ブロックから画像を取得（画像以外の解説テキスト部分はそのまま）
      let explanationImages = [];
      const imageBlock = Array.from(document.querySelectorAll('div.descContent')).find(block => {
        const title = block.querySelector('.descContent--title')?.innerText.trim() || '';
        return title === '画像診断';
      });
      if (imageBlock) {
        // まず "div.figure" 内の画像を優先的に取得し、なければ img タグ全体を対象にする
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


    const combinedData = {
      problem: problemData,
      explanation: explanationData
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

  return results;
}

/**
 * PDF生成関数
 * contents は以下の形式の配列：
 * {
 *   problem: { problemNumber, questionText, problemImageSrcs, problemId, choices },
 *   explanation: { correctAnswer, explanationPoints, optionAnalysis, guideline, explanationImages }
 * }
 */
async function generatePdf(contents, fileName) {
  const documentDefinition = {
    content: [],
    defaultStyle: { font: 'NotoSansJP' },
    styles: {
      header: { fontSize: 16, bold: true, margin: [0, 0, 0, 10] },
      question: { fontSize: 14, margin: [0, 5, 0, 5] },
      choices: { fontSize: 14, margin: [15, 2, 0, 2] },
      explanationHeader: { fontSize: 14, bold: true, margin: [0, 15, 0, 5] },
      analysis: { fontSize: 12, margin: [15, 0, 0, 5] },
      correctAnswer: { fontSize: 15, bold: true, margin: [0, 5, 0, 5] },
      points: { fontSize: 10, margin: [15, 0, 0, 15] },
      error: { fontSize: 10, color: 'red', margin: [0, 5, 0, 5] }
    }
  };

  for (const content of contents) {
    // --- 【問題ページ】 ---
    documentDefinition.content.push(
      { text: `問題番号: ${content.problem.problemNumber}`, style: 'header' },
      { text: `問題ID: ${content.problem.problemId}`, style: 'header' },
      { text: content.problem.questionText, style: 'question' }
    );
  

    // 問題画像（複数ある場合は順次追加）
    if (content.problemImageSrcs && content.problemImageSrcs.length > 0) {
      for (const src of content.problemImageSrcs) {
        try {
          const imageResponse = await fetch(src);
          if (imageResponse.ok) {
            const imageBlob = await imageResponse.blob(); // Blob形式で取得
            const reader = new FileReader();

            reader.onloadend = () => {
              const base64String = reader.result;
              documentDefinition.content.push({
                image: base64String,
                width: 200,
                margin: [0, 5, 0, 5]
              });
            }
            reader.readAsDataURL(imageBlob); // Data URL形式で読み込む

          } else {
            documentDefinition.content.push({ text: "問題画像読み込みエラー", style: 'error' });
          }
        } catch (error) {
          console.error("問題画像読み込みエラー:", error);
          documentDefinition.content.push({ text: "問題画像読み込みエラー", style: 'error' });
        }
      }
    }

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

      // 解説画像
      if (content.explanation.explanationImageSrcs && content.explanation.explanationImageSrcs.length > 0) {
        for (const src of content.explanation.explanationImageSrcs) {
          try {
            const expImgResp = await fetch(src);
            if (expImgResp.ok) {
              const expImgBlob = await expImgResp.blob();// Blob形式で取得
              const expImgReader = new FileReader();
              expImgReader.onloadend = () => {
                const expImgBase64 = expImgReader.result;
                documentDefinition.content.push({
                  image: expImgBase64,
                  width: 150,
                  margin: [0, 5, 0, 5]
                });
              };
              expImgReader.readAsDataURL(expImgBlob);
            } else {
              documentDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
            }
          } catch (error) {
            console.error("解説画像読み込みエラー:", error);
            documentDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
          }
        }
      }

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

// メイン処理
async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const loginUrl = 'https://login.medilink-study.com/login'; // ログインURL
  const email = '';           // ログイン用メール
  const password = '';                               // ログイン用パスワード
  const fileName = "分子細胞(1)";                                // 保存するPDFのファイル名
  const startUrl = 'https://cbt.medilink-study.com/Answer/2012106230'; // 最初の問題ページ
  const numberOfPages = 19;                                     // 取得する問題数 

  // ログイン処理（ここでは puppeteer を使ってログイン）
  await page.goto(loginUrl);
  await page.type('input[name="username"]', email);
  await page.type('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  // 最初の問題ページへ移動
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  // 問題と解説のスクレイピング
  const contents = await scrapeQuestions(page, numberOfPages);

  // PDF生成
  await generatePdf(contents, fileName);

  await browser.close();
}

main().catch((error) => console.error('エラー:', error));
