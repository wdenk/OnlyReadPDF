pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const SCALE_STEP = 0.1;
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;

const openButton = document.getElementById("open-button");
const fileInput = document.getElementById("file-input");
const fileNameLabel = document.getElementById("file-name");
const zoomOutButton = document.getElementById("zoom-out");
const zoomInButton = document.getElementById("zoom-in");
const zoomResetButton = document.getElementById("zoom-reset");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const searchPrevButton = document.getElementById("search-prev");
const searchNextButton = document.getElementById("search-next");
const searchStatus = document.getElementById("search-status");
const viewer = document.getElementById("viewer");
const emptyState = document.getElementById("empty-state");

const state = {
  pdfDoc: null,
  scale: 1,
  matches: [],
  activeMatchIndex: -1,
  renderToken: 0,
};

setControlsEnabled(false);
setFileName("No file selected");

openButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await openFile(file);
  fileInput.value = "";
});

zoomOutButton.addEventListener("click", async () => {
  await setScale(state.scale - SCALE_STEP);
});

zoomInButton.addEventListener("click", async () => {
  await setScale(state.scale + SCALE_STEP);
});

zoomResetButton.addEventListener("click", async () => {
  await setScale(1);
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch({ preferredIndex: 0, jump: true, behavior: "smooth" });
});

searchInput.addEventListener("input", () => {
  runSearch({ preferredIndex: 0, jump: true, behavior: "smooth" });
});

searchPrevButton.addEventListener("click", () => {
  moveMatch(-1);
});

searchNextButton.addEventListener("click", () => {
  moveMatch(1);
});

enableDragAndDrop();
enableCtrlWheelZoom();

async function openFile(file) {
  if (!file) {
    return;
  }

  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    alert("Please drop or open a PDF file.");
    return;
  }

  setFileName(file.name);

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;

    state.pdfDoc = pdfDoc;
    state.scale = 1;
    resetSearch();
    setZoomLabel();
    setControlsEnabled(true);

    await renderAllPages();
    runSearch({ preferredIndex: 0, jump: false, behavior: "instant" });
  } catch (error) {
    console.error(error);
    alert("Could not open this PDF.");
  }
}

function setFileName(name) {
  fileNameLabel.textContent = name;
  fileNameLabel.title = name;
}

function setControlsEnabled(enabled) {
  zoomOutButton.disabled = !enabled;
  zoomInButton.disabled = !enabled;
  zoomResetButton.disabled = !enabled;
  searchInput.disabled = !enabled;
  searchPrevButton.disabled = !enabled;
  searchNextButton.disabled = !enabled;
}

function setZoomLabel() {
  zoomResetButton.textContent = `${Math.round(state.scale * 100)}%`;
}

async function setScale(nextScale) {
  if (!state.pdfDoc) {
    return;
  }

  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(nextScale.toFixed(2))));
  if (clamped === state.scale) {
    return;
  }

  const previousMatchIndex = state.activeMatchIndex;
  state.scale = clamped;
  setZoomLabel();

  await renderAllPages();
  runSearch({
    preferredIndex: previousMatchIndex,
    jump: previousMatchIndex >= 0,
    behavior: "instant",
  });
}

async function renderAllPages() {
  if (!state.pdfDoc) {
    return;
  }

  const currentToken = ++state.renderToken;
  viewer.textContent = "";

  for (let pageNumber = 1; pageNumber <= state.pdfDoc.numPages; pageNumber += 1) {
    if (currentToken !== state.renderToken) {
      return;
    }

    const page = await state.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.scale });

    const pageElement = document.createElement("section");
    pageElement.className = "page";
    pageElement.dataset.pageNumber = String(pageNumber);

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    textLayer.style.setProperty("--scale-factor", String(viewport.scale));

    pageElement.append(canvas);
    pageElement.append(textLayer);
    viewer.append(pageElement);

    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    }).promise;

    const spans = textLayer.querySelectorAll("span");
    for (const span of spans) {
      span.dataset.originalText = span.textContent || "";
    }
  }

  emptyState?.remove();
  paintMatchStyles();
}

function runSearch({ preferredIndex = 0, jump = true, behavior = "smooth" } = {}) {
  if (!state.pdfDoc) {
    return;
  }

  const query = searchInput.value.trim();
  clearHighlights();

  if (!query) {
    resetSearch();
    paintMatchStyles();
    updateSearchStatus();
    return;
  }

  const spans = viewer.querySelectorAll(".text-layer span");
  for (const span of spans) {
    const originalText = span.dataset.originalText || "";
    if (!originalText) {
      continue;
    }

    if (originalText.toLowerCase().includes(query.toLowerCase())) {
      span.innerHTML = highlightText(originalText, query);
    }
  }

  state.matches = Array.from(viewer.querySelectorAll("mark.search-hit"));

  if (state.matches.length === 0) {
    state.activeMatchIndex = -1;
    paintMatchStyles();
    updateSearchStatus();
    return;
  }

  const clampedIndex = Math.max(
    0,
    Math.min(state.matches.length - 1, preferredIndex < 0 ? 0 : preferredIndex)
  );
  state.activeMatchIndex = clampedIndex;

  if (jump) {
    jumpToMatch(clampedIndex, behavior);
  } else {
    paintMatchStyles();
    updateSearchStatus();
  }
}

function clearHighlights() {
  const spans = viewer.querySelectorAll(".text-layer span");
  for (const span of spans) {
    if (span.dataset.originalText !== undefined) {
      span.textContent = span.dataset.originalText;
    }
  }
}

function highlightText(text, query) {
  const escapedQuery = escapeRegExp(query);
  const regex = new RegExp(escapedQuery, "gi");

  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    result += escapeHtml(text.slice(lastIndex, start));
    result += `<mark class="search-hit">${escapeHtml(text.slice(start, end))}</mark>`;
    lastIndex = end;

    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function moveMatch(delta) {
  if (state.matches.length === 0) {
    return;
  }

  const nextIndex =
    (state.activeMatchIndex + delta + state.matches.length) % state.matches.length;
  jumpToMatch(nextIndex, "smooth");
}

function jumpToMatch(matchIndex, behavior) {
  state.activeMatchIndex = matchIndex;
  const matchElement = state.matches[matchIndex];

  if (matchElement) {
    matchElement.scrollIntoView({ block: "center", behavior });
  }

  paintMatchStyles();
  updateSearchStatus();
}

function paintMatchStyles() {
  const pages = viewer.querySelectorAll(".page");
  for (const page of pages) {
    page.classList.remove("match", "active-match");
  }

  const activeMarks = viewer.querySelectorAll(".search-hit.active-hit");
  for (const mark of activeMarks) {
    mark.classList.remove("active-hit");
  }

  for (const match of state.matches) {
    const page = match.closest(".page");
    if (page) {
      page.classList.add("match");
    }
  }

  if (state.activeMatchIndex >= 0) {
    const activeMatch = state.matches[state.activeMatchIndex];
    if (activeMatch) {
      activeMatch.classList.add("active-hit");
      const activePage = activeMatch.closest(".page");
      if (activePage) {
        activePage.classList.add("active-match");
      }
    }
  }
}

function updateSearchStatus() {
  if (state.matches.length === 0) {
    searchStatus.textContent = "0 matches";
    return;
  }

  searchStatus.textContent = `${state.activeMatchIndex + 1}/${state.matches.length}`;
}

function resetSearch() {
  state.matches = [];
  state.activeMatchIndex = -1;
  updateSearchStatus();
}

function enableDragAndDrop() {
  let dragDepth = 0;

  const hasFiles = (event) => {
    const types = event.dataTransfer?.types;
    return Boolean(types && Array.from(types).includes("Files"));
  };

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add("drag-over");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      document.body.classList.remove("drag-over");
    }
  });

  window.addEventListener("drop", async (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("drag-over");
    const file = event.dataTransfer?.files?.[0];
    await openFile(file);
  });
}

function enableCtrlWheelZoom() {
  let wheelDirection = 0;
  let frameRequested = false;

  viewer.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey || !state.pdfDoc) {
        return;
      }

      event.preventDefault();
      wheelDirection += event.deltaY < 0 ? 1 : -1;

      if (frameRequested) {
        return;
      }

      frameRequested = true;
      requestAnimationFrame(async () => {
        const direction = Math.sign(wheelDirection);
        wheelDirection = 0;
        frameRequested = false;

        if (direction === 0) {
          return;
        }

        await setScale(state.scale + direction * SCALE_STEP);
      });
    },
    { passive: false }
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
