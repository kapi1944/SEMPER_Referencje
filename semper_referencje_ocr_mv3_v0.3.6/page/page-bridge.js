(() => {
  'use strict';

  if (window.__SEMPER_OCR_BRIDGE__) return;
  window.__SEMPER_OCR_BRIDGE__ = true;

  const SOURCE = 'semper-referencje-ocr';
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let tesseractPromise = null;
  let workerPromise = null;
  let currentRequestId = null;

  function post(type, payload = {}) {
    window.postMessage({ source: SOURCE, direction: 'bridge-to-extension', type, ...payload }, '*');
  }

  function loadTesseract() {
    if (window.Tesseract?.createWorker) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;

    tesseractPromise = new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((s) => s.src === TESSERACT_URL);
      if (existing) {
        const wait = () => {
          if (window.Tesseract?.createWorker) resolve(window.Tesseract);
          else reject(new Error('Tesseract.js został załadowany, ale API nie jest dostępne.'));
        };
        if (window.Tesseract?.createWorker) resolve(window.Tesseract);
        else {
          existing.addEventListener('load', wait, { once: true });
          existing.addEventListener('error', () => reject(new Error('Nie udało się załadować Tesseract.js.')), { once: true });
        }
        return;
      }

      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (window.Tesseract?.createWorker) resolve(window.Tesseract);
        else reject(new Error('Tesseract.js nie udostępnił createWorker().'));
      };
      script.onerror = () => reject(new Error('Przeglądarka lub CSP strony zablokowały Tesseract.js z CDN.'));
      (document.head || document.documentElement).appendChild(script);
    });

    return tesseractPromise;
  }

  async function getWorker() {
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
      const Tesseract = await loadTesseract();
      const worker = await Tesseract.createWorker(['pol', 'eng'], 1, {
        logger: (message) => {
          if (!message?.status) return;
          const progress = Number.isFinite(message.progress) ? Math.round(message.progress * 100) : null;
          post('OCR_PROGRESS', { requestId: currentRequestId, status: message.status, progress });
        },
        errorHandler: (error) => post('OCR_ENGINE_ERROR', { message: String(error?.message || error) })
      });

      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });

    return workerPromise;
  }

  async function loadImage(url) {
    const response = await fetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Nie udało się pobrać obrazu (HTTP ${response.status}).`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = objectUrl;
    try {
      await img.decode();
      return { img, objectUrl };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  function percentile(values, p) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))] || 0;
  }

  function createPreprocessedCanvases(img) {
    const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
    let scale = maxSide < 1300 ? 2.4 : maxSide < 2000 ? 1.8 : 1.35;
    const targetWidth = Math.max(1, Math.round(img.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(img.naturalHeight * scale));

    const base = document.createElement('canvas');
    base.width = targetWidth;
    base.height = targetHeight;
    const bctx = base.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.fillStyle = '#fff';
    bctx.fillRect(0, 0, base.width, base.height);
    bctx.drawImage(img, 0, 0, base.width, base.height);

    const imageData = bctx.getImageData(0, 0, base.width, base.height);
    const data = imageData.data;
    const sampled = [];
    const stride = Math.max(4, Math.floor((base.width * base.height) / 180000) * 4);
    for (let i = 0; i < data.length; i += stride) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      sampled.push(lum);
    }
    const low = percentile(sampled, 0.04);
    const high = percentile(sampled, 0.96);
    const range = Math.max(35, high - low);

    const gray = document.createElement('canvas');
    gray.width = base.width;
    gray.height = base.height;
    const gctx = gray.getContext('2d', { willReadFrequently: true });
    const grayData = new ImageData(new Uint8ClampedArray(data), base.width, base.height);
    for (let i = 0; i < grayData.data.length; i += 4) {
      const lum = 0.299 * grayData.data[i] + 0.587 * grayData.data[i + 1] + 0.114 * grayData.data[i + 2];
      const stretched = Math.max(0, Math.min(255, ((lum - low) * 255) / range));
      const value = Math.round(Math.pow(stretched / 255, 0.92) * 255);
      grayData.data[i] = value;
      grayData.data[i + 1] = value;
      grayData.data[i + 2] = value;
      grayData.data[i + 3] = 255;
    }
    gctx.putImageData(grayData, 0, 0);

    const binary = document.createElement('canvas');
    binary.width = base.width;
    binary.height = base.height;
    const xctx = binary.getContext('2d', { willReadFrequently: true });
    const binData = gctx.getImageData(0, 0, gray.width, gray.height);
    const graySample = [];
    for (let i = 0; i < binData.data.length; i += stride) graySample.push(binData.data[i]);
    const med = percentile(graySample, 0.58);
    const threshold = Math.max(145, Math.min(220, med - 15));
    for (let i = 0; i < binData.data.length; i += 4) {
      const value = binData.data[i] < threshold ? 0 : 255;
      binData.data[i] = value;
      binData.data[i + 1] = value;
      binData.data[i + 2] = value;
      binData.data[i + 3] = 255;
    }
    xctx.putImageData(binData, 0, 0);

    return [
      { name: 'kontrast', canvas: gray },
      { name: 'binarne', canvas: binary },
      { name: 'oryginal-powiekszony', canvas: base }
    ];
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\r/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function textQuality(text, confidence) {
    const clean = cleanText(text);
    const letters = (clean.match(/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g) || []).length;
    const weird = (clean.match(/[|{}<>~^_=]/g) || []).length;
    const words = clean.split(/\s+/).filter((w) => w.length >= 3).length;
    const polishSignals = (clean.match(/\b(szkoleni|referenc|potwierdz|uczestni|zrealiz|przeprowadz|ustaw|prawo|urząd|kwalifikac)/gi) || []).length;
    return (Number(confidence) || 0) * 0.7 + Math.min(25, letters / 70) + Math.min(12, words / 15) + Math.min(12, polishSignals * 3) - Math.min(25, weird * 2);
  }

  async function recognizeCanvas(worker, canvas, variantName, requestId) {
    currentRequestId = requestId;
    post('OCR_PROGRESS', { requestId, status: `Rozpoznawanie: ${variantName}`, progress: null });
    const result = await worker.recognize(canvas);
    const text = cleanText(result?.data?.text || '');
    const confidence = Math.round(Number(result?.data?.confidence) || 0);
    return {
      variant: variantName,
      text,
      confidence,
      quality: textQuality(text, confidence)
    };
  }

  async function runOcr(imageUrl, requestId) {
    const worker = await getWorker();
    const loaded = await loadImage(imageUrl);
    try {
      const variants = createPreprocessedCanvases(loaded.img);
      const results = [];

      results.push(await recognizeCanvas(worker, variants[0].canvas, variants[0].name, requestId));
      if (results[0].confidence < 82 || results[0].text.length < 220 || results[0].quality < 78) {
        results.push(await recognizeCanvas(worker, variants[1].canvas, variants[1].name, requestId));
      }
      const bestSoFar = results.slice().sort((a, b) => b.quality - a.quality)[0];
      if (bestSoFar.confidence < 70 || bestSoFar.text.length < 140 || bestSoFar.quality < 65) {
        results.push(await recognizeCanvas(worker, variants[2].canvas, variants[2].name, requestId));
      }

      results.sort((a, b) => b.quality - a.quality);
      const best = results[0];
      return {
        text: best.text,
        confidence: best.confidence,
        variant: best.variant,
        attempts: results.map((r) => ({ variant: r.variant, confidence: r.confidence, quality: Math.round(r.quality), length: r.text.length }))
      };
    } finally {
      currentRequestId = null;
      URL.revokeObjectURL(loaded.objectUrl);
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.direction !== 'extension-to-bridge') return;
    if (data.type !== 'RUN_OCR') return;

    const requestId = data.requestId;
    try {
      const result = await runOcr(data.imageUrl, requestId);
      post('OCR_RESULT', { requestId, result });
    } catch (error) {
      console.error('[SEMPER OCR bridge]', error);
      post('OCR_ERROR', { requestId, message: String(error?.message || error) });
    }
  });
})();
