import "./styles.css";
import {
  canvasToBlob,
  detectDocument,
  getCv,
  loadImage,
  renderScan,
  type EnhanceOptions,
  type Point,
  type ScanMode,
} from "./scanner";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span>纸净</span>
      <small>离线文档扫描</small>
    </div>
    <div class="header-actions">
      <button id="sample-button" class="button button-quiet">试用示例</button>
      <button id="open-button" class="button button-primary">打开图片</button>
      <input id="file-input" type="file" accept="image/*" hidden />
    </div>
  </header>

  <main>
    <section id="empty-state" class="empty-state">
      <div class="empty-visual">
        <span class="paper paper-back"></span>
        <span class="paper paper-front"><span>文档</span></span>
        <span class="scan-line"></span>
      </div>
      <h1>让拍下来的纸，重新平整清晰</h1>
      <p>图片只在本机处理，不会上传。支持 JPG、PNG 和 WebP。</p>
      <button id="empty-open-button" class="button button-primary button-large">选择一张图片</button>
      <span class="drop-hint">也可以直接拖到这里</span>
    </section>

    <section id="workspace" class="workspace is-hidden">
      <div class="stage-column">
        <div class="stage-head">
          <div class="segmented" role="tablist">
            <button class="segment active" data-view="corners">校正边界</button>
            <button class="segment" data-view="result">查看效果</button>
          </div>
          <div class="crop-presets" aria-label="裁剪框快捷大小">
            <span>裁剪框</span>
            <button data-crop="0.3333">1/3</button>
            <button data-crop="0.5">1/2</button>
            <button class="active" data-crop="1">全图</button>
          </div>
          <span id="image-info" class="image-info"></span>
        </div>
        <div id="stage" class="stage">
          <canvas id="editor-canvas"></canvas>
          <canvas id="result-canvas" class="is-hidden"></canvas>
          <div id="working" class="working is-hidden"><span></span>正在处理</div>
        </div>
        <p id="stage-tip" class="stage-tip">拖动四个圆点，让边框贴合纸张边缘</p>
      </div>

      <aside class="sidebar">
        <div class="panel-block">
          <div class="panel-title"><span>扫描模式</span><small>实时预览</small></div>
          <div class="mode-grid">
            <button class="mode active" data-mode="color"><span class="mode-swatch color"></span><b>彩色高清</b><small>保留插图</small></button>
            <button class="mode" data-mode="gray"><span class="mode-swatch gray"></span><b>灰度</b><small>柔和清晰</small></button>
            <button class="mode" data-mode="bw"><span class="mode-swatch bw"></span><b>黑白</b><small>适合打印</small></button>
            <button class="mode" data-mode="original"><span class="mode-swatch original"></span><b>仅校正</b><small>不做增强</small></button>
          </div>
        </div>

        <div class="panel-block controls">
          <label><span>书页展平 <output id="flatten-value">70</output></span><input id="flatten" type="range" min="0" max="100" value="70" /></label>
          <label class="enhancement-control"><span>背景净化 <output id="whiten-value">72</output></span><input id="whiten" type="range" min="0" max="100" value="72" /></label>
          <label class="enhancement-control"><span>对比度 <output id="contrast-value">58</output></span><input id="contrast" type="range" min="0" max="100" value="58" /></label>
          <label class="enhancement-control"><span>锐化 <output id="sharpness-value">38</output></span><input id="sharpness" type="range" min="0" max="100" value="38" /></label>
        </div>

        <div class="panel-block compact-actions">
          <button id="redetect-button" class="button button-quiet">重新识别边界</button>
          <button id="reset-button" class="button button-quiet">重置为整图</button>
        </div>

        <div class="export-block">
          <div>
            <strong>导出扫描件</strong>
            <span>高质量 JPG，也可导出 PNG</span>
          </div>
          <div class="export-row">
            <select id="format" aria-label="导出格式"><option value="jpeg">JPG</option><option value="png">PNG</option></select>
            <button id="export-button" class="button button-primary">导出</button>
            <button id="print-button" class="button button-quiet is-hidden" title="">打印</button>
          </div>
        </div>
      </aside>
    </section>
  </main>

  <footer><span id="engine-status"><i></i>正在准备本地图像引擎…</span><span>所有处理均在此设备完成</span></footer>
  <div id="toast" class="toast"></div>
  <div id="print-sheet" class="print-sheet"><img id="print-image" alt="待打印扫描件" /></div>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const fileInput = $("#file-input") as HTMLInputElement;
const editorCanvas = $("#editor-canvas") as HTMLCanvasElement;
const resultCanvas = $("#result-canvas") as HTMLCanvasElement;
const stage = $("#stage") as HTMLDivElement;
const working = $("#working") as HTMLDivElement;
const toast = $("#toast") as HTMLDivElement;
const printButton = $("#print-button") as HTMLButtonElement;
const printImage = $("#print-image") as HTMLImageElement;

let image: HTMLImageElement | null = null;
let imageName = "扫描件";
let imageUrl: string | null = null;
let corners: Point[] = [];
let activeCorner = -1;
let view: "corners" | "result" = "corners";
let renderTimer = 0;
let renderGeneration = 0;
let resultReady = false;
let resultZoom = 1;
let resultPan = { x: 0, y: 0 };
let resultDrag: { pointerId: number; x: number; y: number } | null = null;
let printers: string[] = [];

const options: EnhanceOptions = {
  mode: "color",
  flatten: 70,
  whiten: 72,
  contrast: 58,
  sharpness: 38,
};

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function openPicker(): void {
  fileInput.click();
}

async function openFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    showToast("请选择 JPG、PNG 或 WebP 图片", true);
    return;
  }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = URL.createObjectURL(file);
  imageName = file.name.replace(/\.[^.]+$/, "") || "扫描件";
  await setImage(imageUrl);
}

async function setImage(source: string): Promise<void> {
  try {
    working.classList.remove("is-hidden");
    image = await loadImage(source);
    resetResultViewport();
    resultCanvas.width = 0;
    resultCanvas.height = 0;
    resultReady = false;
    corners = cropCorners(image.naturalWidth, image.naturalHeight, 1);
    setActiveCropPreset("1");
    updatePrintButton();
    $("#empty-state").classList.add("is-hidden");
    $("#workspace").classList.remove("is-hidden");
    $("#image-info").textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    resizeEditor();
    drawEditor();
    scheduleRender(0);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "图片加载失败", true);
  } finally {
    working.classList.add("is-hidden");
  }
}

function cropCorners(width: number, height: number, fraction: number): Point[] {
  const cropWidth = width * fraction;
  const cropHeight = height * fraction;
  const left = (width - cropWidth) / 2;
  const top = (height - cropHeight) / 2;
  return [
    { x: left, y: top },
    { x: left + cropWidth, y: top },
    { x: left + cropWidth, y: top + cropHeight },
    { x: left, y: top + cropHeight },
  ];
}

function setActiveCropPreset(value: string | null): void {
  document.querySelectorAll<HTMLButtonElement>("[data-crop]").forEach((button) => {
    button.classList.toggle("active", value !== null && button.dataset.crop === value);
  });
}

function resizeEditor(): void {
  if (!image) return;
  editorCanvas.width = image.naturalWidth;
  editorCanvas.height = image.naturalHeight;
  drawEditor();
}

function resetResultViewport(): void {
  resultZoom = 1;
  resultPan = { x: 0, y: 0 };
  applyResultViewport();
}

function applyResultViewport(): void {
  resultCanvas.style.left = `calc(50% + ${resultPan.x}px)`;
  resultCanvas.style.top = `calc(50% + ${resultPan.y}px)`;
  resultCanvas.style.transform = `translate(-50%, -50%) scale(${resultZoom})`;
  resultCanvas.classList.toggle("is-zoomed", resultZoom > 1.001);
}

function clampResultPan(): void {
  if (!resultCanvas.width) return;
  const rect = resultCanvas.getBoundingClientRect();
  const baseWidth = rect.width / resultZoom;
  const baseHeight = rect.height / resultZoom;
  const maxX = Math.max(0, (baseWidth * resultZoom - (stage.clientWidth - 48)) / 2);
  const maxY = Math.max(0, (baseHeight * resultZoom - (stage.clientHeight - 40)) / 2);
  resultPan.x = Math.max(-maxX, Math.min(maxX, resultPan.x));
  resultPan.y = Math.max(-maxY, Math.min(maxY, resultPan.y));
}

function drawEditor(): void {
  if (!image) return;
  const context = editorCanvas.getContext("2d")!;
  context.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  context.drawImage(image, 0, 0, editorCanvas.width, editorCanvas.height);

  context.save();
  context.fillStyle = "rgba(7, 16, 13, .48)";
  context.fillRect(0, 0, editorCanvas.width, editorCanvas.height);
  context.globalCompositeOperation = "destination-out";
  context.beginPath();
  corners.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
  context.closePath();
  context.fill();
  context.restore();

  context.beginPath();
  corners.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
  context.closePath();
  context.lineWidth = Math.max(4, editorCanvas.width / 260);
  context.strokeStyle = "#43d69f";
  context.stroke();

  const radius = Math.max(13, editorCanvas.width / 68);
  corners.forEach((point, index) => {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = index === activeCorner ? "#17231f" : "#f9fffc";
    context.fill();
    context.lineWidth = Math.max(5, editorCanvas.width / 220);
    context.strokeStyle = "#43d69f";
    context.stroke();
  });
}

function canvasPoint(event: PointerEvent): Point {
  const rect = editorCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * editorCanvas.width,
    y: (event.clientY - rect.top) / rect.height * editorCanvas.height,
  };
}

function nearestCorner(point: Point): number {
  const rect = editorCanvas.getBoundingClientRect();
  const hitRadius = Math.max(editorCanvas.width / rect.width * 34, editorCanvas.width / 30);
  let index = -1;
  let best = hitRadius;
  corners.forEach((corner, candidate) => {
    const distance = Math.hypot(corner.x - point.x, corner.y - point.y);
    if (distance < best) {
      best = distance;
      index = candidate;
    }
  });
  return index;
}

function scheduleRender(delay = 160): void {
  window.clearTimeout(renderTimer);
  resultReady = false;
  updatePrintButton();
  renderTimer = window.setTimeout(() => void updateResult(), delay);
}

async function updateResult(): Promise<void> {
  if (!image) return;
  window.clearTimeout(renderTimer);
  const generation = ++renderGeneration;
  working.classList.remove("is-hidden");
  try {
    const output = await renderScan(image, corners, options);
    if (generation !== renderGeneration) return;
    resultCanvas.width = output.width;
    resultCanvas.height = output.height;
    resultCanvas.getContext("2d")!.drawImage(output, 0, 0);
    resultReady = true;
    updatePrintButton();
  } catch (error) {
    console.error(error);
    showToast("图像处理失败，请换一张图片重试", true);
  } finally {
    if (generation === renderGeneration) working.classList.add("is-hidden");
  }
}

function updatePrintButton(): void {
  printButton.classList.toggle("is-hidden", printers.length === 0 || !resultReady);
  printButton.title = printers.length > 0 ? `可用打印机：${printers.join("、")}` : "未检测到 Windows 打印机";
}

async function refreshPrinters(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    printers = await invoke<string[]>("list_printers");
  } catch (error) {
    console.warn("读取打印机失败", error);
    printers = [];
  }
  updatePrintButton();
}

async function printResult(): Promise<void> {
  if (!image || printers.length === 0) return;
  if (!resultReady) await updateResult();
  printImage.src = resultCanvas.toDataURL("image/png");
  try {
    await printImage.decode();
  } catch {
    // The image may already be decoded by WebView2.
  }
  window.print();
}

function setView(next: "corners" | "result"): void {
  view = next;
  document.querySelectorAll<HTMLButtonElement>(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  editorCanvas.classList.toggle("is-hidden", view !== "corners");
  resultCanvas.classList.toggle("is-hidden", view !== "result");
  $("#stage-tip").textContent = view === "corners"
    ? "拖动四个圆点，让边框贴合纸张边缘"
    : "滚轮缩放 · 放大后按住图片拖动 · 双击恢复";
  if (view === "result") scheduleRender(0);
}

async function exportImage(): Promise<void> {
  if (!image) return;
  if (!resultReady) await updateResult();
  const format = ($("#format") as HTMLSelectElement).value as "jpeg" | "png";
  const blob = await canvasToBlob(resultCanvas, format);
  const extension = format === "png" ? "png" : "jpg";
  const defaultName = `${imageName}-扫描.${extension}`;

  try {
    if ("__TAURI_INTERNALS__" in window) {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path = await save({ defaultPath: defaultName, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
      if (!path) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    } else {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = defaultName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    showToast(`已导出 ${defaultName}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "导出失败", true);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = "";
});

[$("#open-button"), $("#empty-open-button")].forEach((button) => button.addEventListener("click", openPicker));
$("#sample-button").addEventListener("click", () => {
  imageName = "原图";
  void setImage("/samples/original.jpg");
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
window.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

editorCanvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  setActiveCropPreset(null);
  activeCorner = nearestCorner(canvasPoint(event));
  if (activeCorner >= 0) editorCanvas.setPointerCapture(event.pointerId);
  drawEditor();
});
editorCanvas.addEventListener("pointermove", (event) => {
  if (activeCorner < 0 || !image) return;
  const point = canvasPoint(event);
  corners[activeCorner] = {
    x: Math.max(0, Math.min(image.naturalWidth, point.x)),
    y: Math.max(0, Math.min(image.naturalHeight, point.y)),
  };
  drawEditor();
});
editorCanvas.addEventListener("pointerup", () => {
  if (activeCorner >= 0) scheduleRender();
  activeCorner = -1;
  drawEditor();
});
editorCanvas.addEventListener("pointercancel", () => {
  activeCorner = -1;
  drawEditor();
});

resultCanvas.addEventListener("wheel", (event) => {
  if (view !== "result") return;
  event.preventDefault();
  const stageRect = stage.getBoundingClientRect();
  const cursorX = event.clientX - (stageRect.left + stageRect.width / 2);
  const cursorY = event.clientY - (stageRect.top + stageRect.height / 2);
  const previous = resultZoom;
  const factor = Math.exp(-event.deltaY * 0.0015);
  resultZoom = Math.max(1, Math.min(6, resultZoom * factor));
  const ratio = resultZoom / previous;
  resultPan.x = cursorX - (cursorX - resultPan.x) * ratio;
  resultPan.y = cursorY - (cursorY - resultPan.y) * ratio;
  applyResultViewport();
  clampResultPan();
  applyResultViewport();
}, { passive: false });

resultCanvas.addEventListener("pointerdown", (event) => {
  if (view !== "result" || resultZoom <= 1) return;
  event.preventDefault();
  resultDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  resultCanvas.setPointerCapture(event.pointerId);
  resultCanvas.classList.add("is-dragging");
});
resultCanvas.addEventListener("pointermove", (event) => {
  if (!resultDrag || resultDrag.pointerId !== event.pointerId) return;
  resultPan.x += event.clientX - resultDrag.x;
  resultPan.y += event.clientY - resultDrag.y;
  resultDrag.x = event.clientX;
  resultDrag.y = event.clientY;
  clampResultPan();
  applyResultViewport();
});
function finishResultDrag(event: PointerEvent): void {
  if (resultDrag?.pointerId === event.pointerId) resultDrag = null;
  resultCanvas.classList.remove("is-dragging");
}
resultCanvas.addEventListener("pointerup", finishResultDrag);
resultCanvas.addEventListener("pointercancel", finishResultDrag);
resultCanvas.addEventListener("dblclick", resetResultViewport);

document.querySelectorAll<HTMLButtonElement>(".segment").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view as "corners" | "result"));
});
document.querySelectorAll<HTMLButtonElement>("[data-crop]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!image) return;
    const fraction = Number(button.dataset.crop);
    corners = cropCorners(image.naturalWidth, image.naturalHeight, fraction);
    setActiveCropPreset(button.dataset.crop ?? null);
    drawEditor();
    scheduleRender(0);
    setView("corners");
  });
});
document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => {
  button.addEventListener("click", () => {
    options.mode = button.dataset.mode as ScanMode;
    document.querySelectorAll(".mode").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const enhancementsDisabled = options.mode === "original" || options.mode === "bw";
    document.querySelectorAll<HTMLInputElement>(".enhancement-control input").forEach((input) => {
      input.disabled = enhancementsDisabled;
      input.closest("label")?.classList.toggle("disabled", enhancementsDisabled);
    });
    setView("result");
  });
});

(["flatten", "whiten", "contrast", "sharpness"] as const).forEach((key) => {
  const input = $(`#${key}`) as HTMLInputElement;
  input.addEventListener("input", () => {
    options[key] = Number(input.value);
    ($(`#${key}-value`) as HTMLOutputElement).value = input.value;
    scheduleRender();
  });
});

$("#redetect-button").addEventListener("click", async () => {
  if (!image) return;
  working.classList.remove("is-hidden");
  corners = await detectDocument(image);
  setActiveCropPreset(null);
  drawEditor();
  working.classList.add("is-hidden");
  scheduleRender(0);
  setView("corners");
});
$("#reset-button").addEventListener("click", () => {
  if (!image) return;
  corners = cropCorners(image.naturalWidth, image.naturalHeight, 1);
  setActiveCropPreset("1");
  drawEditor();
  scheduleRender(0);
  setView("corners");
});
$("#export-button").addEventListener("click", () => void exportImage());
printButton.addEventListener("click", () => void printResult());

new ResizeObserver(() => {
  drawEditor();
  clampResultPan();
  applyResultViewport();
}).observe(stage);

getCv().then(() => {
  $("#engine-status").innerHTML = "<i></i>本地图像引擎已就绪";
  $("#engine-status").classList.add("ready");
}).catch(() => {
  $("#engine-status").textContent = "图像引擎加载失败";
});

void refreshPrinters();
