const state = {
  rows: [],
  filteredRows: [],
  schemaRegistry: new Map(),
  availableColumns: [],
  groupedColumns: new Map(),
  visibleColumns: [],
  sortKey: "weaponName",
  sortDirection: "asc",
  currentPage: 1,
  rowsPerPage: 50,
  activeFilters: [],
  presets: {},
  calculatedColumns: [],
  collapsedColumnGroups: new Set(),
  collapsedColumnOrderGroups: new Set(),
  activePresetName: "default",
  pinnedRowKeys: [],
  filterPresets: {},
  activeFilterPresetName: "default",
  calcPresets: {},
  activeCalcPresetName: "default",
  focusFilterId: null,
  editingFilterId: null,
  focusClauseId: null,
  editingCalcId: null,
  focusCalcId: null,
  activeVersionTag: null,
  columnDisplayWidths: new Map(),
};

let suppressPresetSelectChange = false;
let suppressFilterPresetSelectChange = false;
let suppressCalcPresetSelectChange = false;
let columnOrderDragState = null;
let weaponHistoryManifest = null;
let weaponHistoryEnabled = false;
const versionDataCache = new Map();

const WEAPON_HISTORY_DIR = "./data/weapon-history";
const WEAPON_HISTORY_MANIFEST_URL = `${WEAPON_HISTORY_DIR}/manifest.json`;

function isLocalDevHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function getUrlParams() {
  return new URLSearchParams(location.search);
}

function resolveWeaponDataUrl() {
  const override = getUrlParams().get("data");
  if (override) return override;
  if (isLocalDevHost(location.hostname)) return "./weapon.json";
  return "./data/weapon-history/latest.json.gz";
}

function resolveHistoryAssetUrl(relativePath) {
  return `${WEAPON_HISTORY_DIR}/${String(relativePath).replace(/^\//, "")}`;
}

async function fetchGzJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  if (!url.endsWith(".gz")) {
    return response.json();
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress .gz files (DecompressionStream unavailable).");
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return JSON.parse(text);
}

async function loadWeaponData(url) {
  return fetchGzJson(url);
}

async function loadWeaponHistoryManifest() {
  try {
    const response = await fetch(WEAPON_HISTORY_MANIFEST_URL);
    if (!response.ok) return null;
    const manifest = await response.json();
    if (!Array.isArray(manifest?.versions) || manifest.versions.length === 0) return null;
    return manifest;
  } catch (error) {
    console.warn("[viewer] Weapon history manifest unavailable.", error);
    return null;
  }
}

function pathKey(path, { reverseIndex = false } = {}) {
  return path
    .split("/")
    .slice(1)
    .map((segment) => {
      if (/^\d+$/.test(segment)) {
        const index = Number(segment);
        return reverseIndex ? -index : index;
      }
      return segment;
    });
}

function pointerSegments(pointer) {
  return pointer.split("/").filter(Boolean);
}

function resolveParent(root, segments, createMissing = false) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      if (!(segment in current)) {
        if (!createMissing) throw new KeyError(segment);
        current[segment] = {};
      }
      current = current[segment];
      continue;
    }
    current = current[Number(segment)];
  }
  return [current, segments[segments.length - 1]];
}

class KeyError extends Error {
  constructor(segment) {
    super(`Missing path segment: ${segment}`);
    this.name = "KeyError";
  }
}

function applyPatch(data, patch) {
  const result = structuredClone(data);
  const removes = patch
    .filter((operation) => operation.op === "remove")
    .sort((left, right) => {
      const a = pathKey(left.p, { reverseIndex: true });
      const b = pathKey(right.p, { reverseIndex: true });
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
  const replaces = patch.filter((operation) => operation.op === "replace");
  const adds = patch
    .filter((operation) => operation.op === "add")
    .sort((left, right) => JSON.stringify(pathKey(left.p)).localeCompare(JSON.stringify(pathKey(right.p))));

  for (const operation of removes) {
    const [parent, key] = resolveParent(result, pointerSegments(operation.p));
    if (Array.isArray(parent)) {
      parent.splice(Number(key), 1);
    } else {
      delete parent[key];
    }
  }

  for (const operation of replaces) {
    const [parent, key] = resolveParent(result, pointerSegments(operation.p));
    if (Array.isArray(parent)) {
      parent[Number(key)] = operation.v;
    } else {
      parent[key] = operation.v;
    }
  }

  for (const operation of adds) {
    const [parent, key] = resolveParent(result, pointerSegments(operation.p), true);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (index === parent.length) {
        parent.push(operation.v);
      } else {
        parent.splice(index, 0, operation.v);
      }
    } else {
      parent[key] = operation.v;
    }
  }

  return result;
}

function canUseLatestSnapshot(tag) {
  return (
    tag === weaponHistoryManifest?.latestTag &&
    typeof weaponHistoryManifest?.latestSnapshotFile === "string" &&
    weaponHistoryManifest.latestSnapshotFile.length > 0
  );
}

async function loadLatestSnapshot(tag) {
  const data = await fetchGzJson(resolveHistoryAssetUrl(weaponHistoryManifest.latestSnapshotFile));
  versionDataCache.set(tag, structuredClone(data));
  return structuredClone(data);
}

async function loadWeaponDataForVersion(tag) {
  if (!weaponHistoryManifest) {
    throw new Error("Weapon history manifest is not loaded.");
  }

  if (versionDataCache.has(tag)) {
    return structuredClone(versionDataCache.get(tag));
  }

  if (canUseLatestSnapshot(tag)) {
    try {
      return await loadLatestSnapshot(tag);
    } catch (error) {
      console.warn("[viewer] Latest snapshot unavailable, falling back to patch chain.", error);
    }
  }

  const versions = weaponHistoryManifest.versions;
  const targetIndex = versions.findIndex((version) => version.tag === tag);
  if (targetIndex < 0) {
    throw new Error(`Unknown version tag: ${tag}`);
  }

  let data = null;
  let startIndex = 0;

  for (let index = targetIndex; index >= 0; index -= 1) {
    const versionTag = versions[index].tag;
    if (versionDataCache.has(versionTag)) {
      data = structuredClone(versionDataCache.get(versionTag));
      startIndex = index + 1;
      break;
    }
  }

  for (let index = startIndex; index <= targetIndex; index += 1) {
    const version = versions[index];
    if (version.role === "base") {
      data = await fetchGzJson(resolveHistoryAssetUrl(version.file));
      versionDataCache.set(version.tag, structuredClone(data));
      continue;
    }

    const patch = await fetchGzJson(resolveHistoryAssetUrl(version.file));
    data = applyPatch(data, patch);
    versionDataCache.set(version.tag, structuredClone(data));
  }

  return data;
}

function resolveInitialVersionTag(session) {
  const params = getUrlParams();
  const requested = params.get("version");
  if (requested && weaponHistoryManifest?.versions?.some((version) => version.tag === requested)) {
    return requested;
  }
  if (session?.activeVersionTag && weaponHistoryManifest?.versions?.some((version) => version.tag === session.activeVersionTag)) {
    return session.activeVersionTag;
  }
  return weaponHistoryManifest?.latestTag || null;
}

function renderVersionSelect(selectedTag) {
  if (!elements.versionSelect || !weaponHistoryManifest) return;

  const versions = [...weaponHistoryManifest.versions].reverse();
  elements.versionSelect.innerHTML = versions
    .map((version) => {
      const suffix = version.tag === weaponHistoryManifest.latestTag ? " (latest)" : "";
      return `<option value="${version.tag}">${version.tag}${suffix}</option>`;
    })
    .join("");
  elements.versionSelect.value = selectedTag;
  elements.versionSelect.disabled = false;
  elements.versionSelect.closest("label")?.classList.remove("is-hidden");
}

function hideVersionSelect() {
  if (!elements.versionSelect) return;
  elements.versionSelect.innerHTML = "";
  elements.versionSelect.disabled = true;
  elements.versionSelect.closest("label")?.classList.add("is-hidden");
}

function setVersionSelectBusy(isBusy) {
  if (!elements.versionSelect) return;
  elements.versionSelect.disabled = isBusy;
}

function resolveElement(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
}

const elements = {
  searchInput: document.getElementById("searchInput"),
  factionFilter: document.getElementById("factionFilter"),
  categoryFilter: document.getElementById("categoryFilter"),
  versionSelect: document.getElementById("versionSelect"),
  rowsPerPage: document.getElementById("rowsPerPage"),
  attributeSearchInput: resolveElement("attributeSearchInput", "columnSearchInput"),
  attributeChooserBody: resolveElement("attributeChooserBody", "columnList"),
  showAllAttributesBtn: resolveElement("showAllAttributesBtn", "showAllColumnsBtn"),
  clearAttributesBtn: resolveElement("clearAttributesBtn", "clearColumnsBtn"),
  expandAllGroupsBtn: document.getElementById("expandAllGroupsBtn"),
  collapseAllGroupsBtn: document.getElementById("collapseAllGroupsBtn"),
  addFilterBtn: document.getElementById("addFilterBtn"),
  activateAllFiltersBtn: document.getElementById("activateAllFiltersBtn"),
  deactivateAllFiltersBtn: document.getElementById("deactivateAllFiltersBtn"),
  filterTableBody: document.getElementById("filterTableBody"),
  filterPresetSelect: document.getElementById("filterPresetSelect"),
  saveFilterPresetBtn: document.getElementById("saveFilterPresetBtn"),
  manageFilterPresetsBtn: document.getElementById("manageFilterPresetsBtn"),
  manageFilterPresetsDialog: document.getElementById("manageFilterPresetsDialog"),
  closeManageFilterPresetsBtn: document.getElementById("closeManageFilterPresetsBtn"),
  filterPresetManageTableBody: document.getElementById("filterPresetManageTableBody"),
  calcTableBody: document.getElementById("calcTableBody"),
  calcPresetSelect: document.getElementById("calcPresetSelect"),
  saveCalcPresetBtn: document.getElementById("saveCalcPresetBtn"),
  manageCalcPresetsBtn: document.getElementById("manageCalcPresetsBtn"),
  manageCalcPresetsDialog: document.getElementById("manageCalcPresetsDialog"),
  closeManageCalcPresetsBtn: document.getElementById("closeManageCalcPresetsBtn"),
  calcPresetManageTableBody: document.getElementById("calcPresetManageTableBody"),
  displayAllCalcBtn: document.getElementById("displayAllCalcBtn"),
  clearCalcColumnsBtn: document.getElementById("clearCalcColumnsBtn"),
  addCalcColumnBtn: document.getElementById("addCalcColumnBtn"),
  columnOrderList: document.getElementById("columnOrderList"),
  resetColumnOrderBtn: document.getElementById("resetColumnOrderBtn"),
  expandColumnOrderGroupsBtn: document.getElementById("expandColumnOrderGroupsBtn"),
  collapseColumnOrderGroupsBtn: document.getElementById("collapseColumnOrderGroupsBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  savePresetBtn: document.getElementById("savePresetBtn"),
  presetSelect: document.getElementById("presetSelect"),
  managePresetsBtn: document.getElementById("managePresetsBtn"),
  managePresetsDialog: document.getElementById("managePresetsDialog"),
  closeManagePresetsBtn: document.getElementById("closeManagePresetsBtn"),
  presetManageTableBody: document.getElementById("presetManageTableBody"),
  statusText: document.getElementById("statusText"),
  pageText: document.getElementById("pageText"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  tableHead: document.querySelector("#statsTable thead"),
  pinnedTableBody: document.getElementById("pinnedTableBody"),
  tableBody: document.getElementById("tableBody"),
  tableWrap: document.getElementById("tableWrap"),
  topDrawers: document.querySelectorAll(".top-drawer"),
  drawerTriggers: document.querySelectorAll(".drawer-trigger"),
  topDrawerBackdrop: document.getElementById("topDrawerBackdrop"),
};

let activeDrawerPanel = null;

const STORAGE_KEYS = {
  session: "coh3_weapon_viewer_session_v1",
  presets: "coh3_weapon_viewer_presets_v1",
  filterPresets: "coh3_weapon_viewer_filter_presets_v1",
  calcPresets: "coh3_weapon_viewer_calc_presets_v1",
};

const DEFAULT_PRESET_NAME = "default";
const DEFAULT_FILTER_PRESET_NAME = "default";
const DEFAULT_CALC_PRESET_NAME = "default";

const CORE_COLUMNS = [
  "weaponName",
  "faction",
  "category",
  "weapon_class",
  "default_attack_type",
  "damage.max",
  "damage.min",
  "penetration.near",
  "penetration.mid",
  "penetration.far",
  "accuracy.near",
  "accuracy.mid",
  "accuracy.far",
  "range.max",
  "range.min",
  "reload.duration.min",
  "reload.duration.max",
];

const REQUIRED_VISIBLE_COLUMN = "weaponName";

function ensureRequiredVisibleColumns(columns) {
  if (!state.availableColumns.includes(REQUIRED_VISIBLE_COLUMN)) return columns;
  if (columns.includes(REQUIRED_VISIBLE_COLUMN)) return columns;
  return [REQUIRED_VISIBLE_COLUMN, ...columns];
}

function normalizePrimitive(value) {
  if (typeof value === "string") {
    if (value === "True") return true;
    if (value === "False") return false;
  }
  return value;
}

function updateRegistry(path, value) {
  const valueType = value === null ? "null" : typeof value;
  const existing = state.schemaRegistry.get(path);
  if (!existing) {
    state.schemaRegistry.set(path, { path, type: valueType, presence: 1, sample: String(value) });
    return;
  }
  existing.presence += 1;
}

function summarizeArray(array, maxLength = 240) {
  const leaves = [];
  function walk(value) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(walk);
      return;
    }
    leaves.push(String(value));
  }
  array.forEach(walk);
  const text = [...new Set(leaves)].join("; ");
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function registerArrayColumns(basePath, array, out, complex) {
  const arrayKey = `${basePath}[]`;
  const countKey = `${arrayKey}.count`;
  const summaryKey = `${arrayKey}.summary`;

  const count = array.length;
  out[countKey] = count;
  updateRegistry(countKey, count);

  const jsonValue = count ? JSON.stringify(array) : "";
  out[arrayKey] = jsonValue;
  updateRegistry(arrayKey, jsonValue);

  const summary = summarizeArray(array);
  out[summaryKey] = summary;
  updateRegistry(summaryKey, summary);

  complex[arrayKey] = array;

  array.forEach((item, index) => {
    if (item !== null && item !== undefined) {
      flattenScalarFields(item, `${basePath}[${index}]`, out, complex);
    }
  });
}

function flattenScalarFields(node, prefix, out, complex) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    const basePath = prefix || "array";
    registerArrayColumns(basePath, node, out, complex);
    return;
  }
  if (typeof node !== "object") {
    const normalized = normalizePrimitive(node);
    out[prefix] = normalized;
    updateRegistry(prefix, normalized);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        registerArrayColumns(next, value, out, complex);
      } else {
        flattenScalarFields(value, next, out, complex);
      }
    } else {
      const normalized = normalizePrimitive(value);
      out[next] = normalized;
      updateRegistry(next, normalized);
    }
  }
}

function flattenWeapons(root) {
  const rows = [];
  state.schemaRegistry.clear();

  function walk(node, pathSegments) {
    if (!node || typeof node !== "object") return;

    if (node.weapon_bag && typeof node.weapon_bag === "object") {
      const scalarFields = {};
      const complexFields = {};
      const weaponName = pathSegments[pathSegments.length - 1] || "unknown_weapon";
      flattenScalarFields(node.weapon_bag, "", scalarFields, complexFields);
      updateRegistry("weaponName", weaponName);
      updateRegistry("faction", pathSegments[0] || "");
      updateRegistry("category", pathSegments[1] || "");
      rows.push({
        weaponName,
        faction: pathSegments[0] || "",
        category: pathSegments[1] || "",
        ...scalarFields,
        _complex: complexFields,
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        walk(value, [...pathSegments, key]);
      }
    }
  }

  walk(root, []);
  return rows;
}

function buildAvailableColumns() {
  const base = ["weaponName", "faction", "category"];
  const dynamic = [...state.schemaRegistry.keys()].filter((key) => !base.includes(key)).sort();
  state.availableColumns = [...base, ...dynamic];
  buildGroupedColumns();
}

function getColumnGroup(column) {
  if (column === "weaponName" || column === "faction" || column === "category") {
    return "identity";
  }
  const top = column.split(".")[0];
  return top.replace(/\[\d+\]$/, "").replace(/\[\]$/, "") || "root";
}

function getColumnPathParts(column) {
  if (column === "weaponName") {
    return ["weaponName"];
  }
  if (column === "faction" || column === "category") {
    return ["identity", column];
  }
  if (column.includes(".")) {
    return column.split(".");
  }
  return [column];
}

function formatAttributeFullPath(column) {
  return getColumnPathParts(column).join(".");
}

function buildMultiRowHeader(columns) {
  const paths = columns.map((key) => ({ key, parts: getColumnPathParts(key) }));
  const maxDepth = Math.max(...paths.map((p) => p.parts.length), 1);
  const numCols = columns.length;
  const occupied = Array.from({ length: maxDepth }, () => Array(numCols).fill(false));
  const rows = Array.from({ length: maxDepth }, () => []);

  for (let level = 0; level < maxDepth; level++) {
    for (let colIndex = 0; colIndex < numCols; colIndex++) {
      if (occupied[level][colIndex]) continue;

      const path = paths[colIndex];
      const n = path.parts.length;

      if (n === 1) {
        if (level !== 0) continue;
        const rowspan = maxDepth;
        for (let dr = 0; dr < rowspan; dr++) {
          occupied[level + dr][colIndex] = true;
        }
        rows[level].push({
          text: path.parts[0],
          colspan: 1,
          rowspan,
          key: path.key,
          sortable: true,
          isLastCol: colIndex === numCols - 1,
        });
        continue;
      }

      if (level > n - 1) continue;

      let partIndex;
      let isLeaf;
      if (level === n - 1) {
        partIndex = n - 1;
        isLeaf = true;
      } else {
        partIndex = level;
        isLeaf = false;
      }

      const label = path.parts[partIndex];

      let colspan = 1;
      if (!isLeaf) {
        while (colIndex + colspan < numCols) {
          const next = paths[colIndex + colspan];
          const nextN = next.parts.length;
          if (nextN <= level) break;
          const prefixA = path.parts.slice(0, partIndex + 1).join("\0");
          const prefixB = next.parts.slice(0, partIndex + 1).join("\0");
          if (prefixA !== prefixB) break;
          colspan++;
        }
      }

      const rowspan = isLeaf ? maxDepth - level : 1;

      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          occupied[level + dr][colIndex + dc] = true;
        }
      }

      rows[level].push({
        text: label,
        colspan,
        rowspan,
        key: isLeaf ? path.key : null,
        sortable: isLeaf,
        isLastCol: colIndex + colspan - 1 === numCols - 1,
      });
    }
  }

  return { rows, maxDepth };
}

function renderMultiRowHeader(columns) {
  const { rows, maxDepth } = buildMultiRowHeader(columns);
  elements.tableHead.innerHTML = "";

  rows.forEach((cells, rowIndex) => {
    const tr = document.createElement("tr");
    tr.className = `header-row header-row-${rowIndex}`;

    for (const cell of cells) {
      const th = document.createElement("th");
      th.colSpan = cell.colspan;
      th.rowSpan = cell.rowspan;
      th.textContent = cell.text;
      th.className = cell.sortable ? "header-leaf" : "header-tier";
      th.dataset.label = cell.text;
      if (cell.isLastCol) {
        th.classList.add("header-last-col");
      }
      if (cell.key && getCalcColumnNameSet().has(cell.key)) {
        th.classList.add("header-calc-col");
      }

      if (cell.sortable && cell.key) {
        th.dataset.key = cell.key;
        th.addEventListener("click", () => {
          if (state.sortKey === cell.key) {
            state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
          } else {
            state.sortKey = cell.key;
            state.sortDirection = "asc";
          }
          applyFiltersAndSort();
        });
      }

      tr.appendChild(th);
    }

    elements.tableHead.appendChild(tr);
  });

  elements.tableHead.dataset.headerDepth = String(maxDepth);
  markStickyHeaderCells();
}

const PIN_ICON_OUTLINE_SVG = `<svg class="table-pin-icon" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" transform="rotate(45 12 12)" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Zm-.83 3H8.83C9.56 11.1 10 10.06 10 9V4h4v5c0 1.06.44 2.1 1.17 3Z"/></svg>`;

const PIN_ICON_SOLID_SVG = `<svg class="table-pin-icon" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" transform="rotate(45 12 12)" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Z"/></svg>`;

function getRowKey(row) {
  return `${row.faction}|${row.category}|${row.weaponName}`;
}

function findRowByKey(key) {
  return state.rows.find((row) => getRowKey(row) === key) || null;
}

function isRowPinned(row) {
  return state.pinnedRowKeys.includes(getRowKey(row));
}

function togglePinRow(key) {
  const index = state.pinnedRowKeys.indexOf(key);
  if (index >= 0) {
    state.pinnedRowKeys.splice(index, 1);
  } else {
    state.pinnedRowKeys.push(key);
  }
  renderTable();
  saveSessionState();
}

function markStickyHeaderCells() {
  const firstColumn = state.visibleColumns[0];
  if (!firstColumn) return;
  const leafHeader = [...elements.tableHead.querySelectorAll("th.header-leaf")].find(
    (th) => th.dataset.key === firstColumn,
  );
  if (leafHeader) {
    leafHeader.classList.add("sticky-col");
  }
}

function createPinButton(row) {
  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = `row-pin-btn${isRowPinned(row) ? " is-pinned" : ""}`;
  pinBtn.title = isRowPinned(row) ? "Unpin row" : "Pin row";
  pinBtn.setAttribute("aria-label", pinBtn.title);
  pinBtn.innerHTML = isRowPinned(row) ? PIN_ICON_SOLID_SVG : PIN_ICON_OUTLINE_SVG;
  pinBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePinRow(getRowKey(row));
  });
  return pinBtn;
}

function createTableRow(row, { pinned = false } = {}) {
  const tr = document.createElement("tr");
  if (pinned) {
    tr.classList.add("is-pinned-row");
  }

  state.visibleColumns.forEach((key, colIndex) => {
    const td = document.createElement("td");
    if (colIndex === 0) {
      td.classList.add("sticky-col");
    }

    if (key === "weaponName") {
      td.classList.add("cell-weapon-name");
      const textSpan = document.createElement("span");
      textSpan.className = "cell-weapon-name-text";
      textSpan.textContent = formatCell(row[key], key);
      td.appendChild(textSpan);
      td.appendChild(createPinButton(row));
    } else {
      td.textContent = formatCell(row[key], key);
    }

    if (!isAggregateArrayColumn(key) && state.columnDisplayWidths.has(key)) {
      td.classList.add("scalar-col");
    } else if (isAggregateArrayColumn(key) && state.columnDisplayWidths.has(key)) {
      td.classList.add("array-col");
    }

    tr.appendChild(td);
  });

  return tr;
}

function updateTableLayoutVars() {
  if (!elements.tableWrap) return;
  const headerHeight = Math.ceil(elements.tableHead?.getBoundingClientRect().height || 0);
  elements.tableWrap.style.setProperty("--table-header-height", `${headerHeight}px`);
}

function buildGroupedColumns() {
  const groups = new Map();
  for (const column of state.availableColumns) {
    const group = getColumnGroup(column);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(column);
  }
  for (const values of groups.values()) {
    values.sort();
  }
  state.groupedColumns = new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function fillSelectOptions(selectElement, values, defaultLabel) {
  selectElement.innerHTML = `<option value="">${defaultLabel}</option>`;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectElement.appendChild(option);
  }
}

function getColumnType(column) {
  return state.schemaRegistry.get(column)?.type || "string";
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatCell(value, column = "") {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    const isJsonArrayColumn = column.endsWith("[]") && (value.startsWith("[") || value === "");
    if (isJsonArrayColumn && value.length > 100) {
      return `${value.slice(0, 100)}…`;
    }
    if (column.endsWith(".summary") && value.length > 120) {
      return `${value.slice(0, 120)}…`;
    }
    return value;
  }
  return value ?? "";
}

function isAggregateArrayColumn(column) {
  if (!column || !column.includes("[]")) return false;
  return column.endsWith("[]") || column.endsWith(".count") || column.endsWith(".summary");
}

function getColumnHeaderLabel(column) {
  const parts = getColumnPathParts(column);
  return parts[parts.length - 1] || column;
}

function measureColumnCellText(row, column) {
  return String(formatCell(row[column], column));
}

function computeScalarColumnDisplayWidths() {
  state.columnDisplayWidths = new Map();

  const paddingCh = 2.5;
  const sortReserveCh = 2;
  const minCh = 5;
  const absoluteMaxCh = 96;
  const weaponNamePinReserveCh = 3.5;

  for (const column of state.availableColumns) {
    if (isAggregateArrayColumn(column)) {
      let maxLen = getColumnHeaderLabel(column).length + sortReserveCh;
      for (const row of state.rows) {
        const textLen = measureColumnCellText(row, column).length;
        if (textLen > maxLen) maxLen = textLen;
      }
      const widthCh = Math.min(absoluteMaxCh, Math.max(minCh, maxLen + paddingCh));
      state.columnDisplayWidths.set(column, widthCh);
      continue;
    }

    let maxLen = getColumnHeaderLabel(column).length + sortReserveCh;
    for (const row of state.rows) {
      const textLen = measureColumnCellText(row, column).length;
      if (textLen > maxLen) maxLen = textLen;
    }

    let widthCh = maxLen + paddingCh;
    if (column === "weaponName") {
      widthCh += weaponNamePinReserveCh;
      widthCh = Math.min(widthCh, 55);
    }
    widthCh = Math.min(absoluteMaxCh, Math.max(minCh, widthCh));
    state.columnDisplayWidths.set(column, widthCh);
  }
}

function setTableColWidthCh(col, widthCh) {
  const width = `${widthCh}ch`;
  col.style.width = width;
  col.style.minWidth = width;
  col.style.maxWidth = width;
}

function applyTableColumnWidths() {
  const table = document.getElementById("statsTable");
  if (!table || state.visibleColumns.length === 0) return;

  let colgroup = table.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.prepend(colgroup);
  }
  colgroup.replaceChildren();

  for (const column of state.visibleColumns) {
    const col = document.createElement("col");
    const widthCh = state.columnDisplayWidths.get(column);
    if (widthCh) {
      setTableColWidthCh(col, widthCh);
      col.className = isAggregateArrayColumn(column) ? "array-col" : "scalar-col";
    }
    colgroup.appendChild(col);
  }

  for (const th of elements.tableHead.querySelectorAll("th.header-leaf[data-key]")) {
    const key = th.dataset.key;
    const hasFixedWidth = state.columnDisplayWidths.has(key);
    th.classList.toggle("scalar-col", hasFixedWidth && !isAggregateArrayColumn(key));
    th.classList.toggle("array-col", hasFixedWidth && isAggregateArrayColumn(key));
  }
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "boolean"
      ? value
        ? "true"
        : "false"
      : typeof value === "number"
        ? String(value)
        : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportFilteredRowsToCsv() {
  const columns = state.visibleColumns.length ? state.visibleColumns : CORE_COLUMNS;
  if (state.filteredRows.length === 0) {
    window.alert("No rows to export. Adjust search or filters and try again.");
    return;
  }

  const header = columns.map((column) => csvEscape(formatAttributeFullPath(column))).join(",");
  const body = state.filteredRows
    .map((row) => columns.map((column) => csvEscape(row[column])).join(","))
    .join("\r\n");
  const csv = `\uFEFF${header}\r\n${body}`;

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `coh3-weapon-stats-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function matchesFilter(row, filter) {
  const mode = filter.mode || "value";
  const value = row[filter.column];
  if (filter.operator === "is_empty") return value === undefined || value === null || value === "";
  if (filter.operator === "is_not_empty") return !(value === undefined || value === null || value === "");
  if (value === undefined || value === null) return false;

  const type = getColumnType(filter.column);
  const rhs = mode === "column" ? row[filter.compareColumn] : filter.value1;
  if (mode === "column" && (rhs === undefined || rhs === null)) return false;

  if (type === "number") {
    const n = Number(value);
    const a = Number(rhs);
    const b = Number(filter.value2);
    if (Number.isNaN(n)) return false;
    if (!["is_empty", "is_not_empty"].includes(filter.operator) && Number.isNaN(a)) return false;
    if (filter.operator === "eq") return n === a;
    if (filter.operator === "neq") return n !== a;
    if (filter.operator === "gt") return n > a;
    if (filter.operator === "gte") return n >= a;
    if (filter.operator === "lt") return n < a;
    if (filter.operator === "lte") return n <= a;
    if (filter.operator === "between") return n >= a && n <= b;
    return true;
  }

  if (type === "boolean") {
    const expected = mode === "column" ? Boolean(rhs) : filter.value1 === "true";
    if (filter.operator === "eq") return value === expected;
    if (filter.operator === "neq") return value !== expected;
    return true;
  }

  const text = String(value).toLowerCase();
  const needle = String(rhs || "").toLowerCase();
  if (filter.operator === "contains") return text.includes(needle);
  if (filter.operator === "not_contains") return !text.includes(needle);
  if (filter.operator === "eq") return text === needle;
  if (filter.operator === "neq") return text !== needle;
  return true;
}

function compareValues(a, b) {
  const aNull = a === undefined || a === null || a === "";
  const bNull = b === undefined || b === null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

function tokenizeExpression(expression) {
  const tokens = [];
  const regex = /\{([^}]+)\}|>=|<=|==|!=|&&|\|\||\d+(?:\.\d+)?|[()+*/\-]|[<>]/g;
  let matched = "";
  let m;
  while ((m = regex.exec(expression || "")) !== null) {
    const token = m[0];
    matched += token;
    if (token.startsWith("{")) {
      tokens.push({ type: "column", value: token.slice(1, -1).trim() });
    } else if (/^\d/.test(token)) {
      tokens.push({ type: "number", value: Number(token) });
    } else {
      tokens.push({ type: "op", value: token });
    }
  }
  const normalized = String(expression || "").replace(/\s+/g, "");
  if (matched !== normalized) return null;
  return tokens;
}

function expressionToRpn(tokens) {
  const output = [];
  const ops = [];
  const precedence = {
    "||": 1,
    "&&": 2,
    "==": 3,
    "!=": 3,
    ">": 4,
    "<": 4,
    ">=": 4,
    "<=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
  };
  for (const token of tokens) {
    if (token.type === "number" || token.type === "column") {
      output.push(token);
      continue;
    }
    if (token.value === "(") {
      ops.push(token.value);
      continue;
    }
    if (token.value === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") {
        output.push({ type: "op", value: ops.pop() });
      }
      if (!ops.length) return null;
      ops.pop();
      continue;
    }
    while (ops.length && ops[ops.length - 1] !== "(" && precedence[ops[ops.length - 1]] >= precedence[token.value]) {
      output.push({ type: "op", value: ops.pop() });
    }
    ops.push(token.value);
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === "(" || op === ")") return null;
    output.push({ type: "op", value: op });
  }
  return output;
}

function readColumnValue(row, column) {
  const val = row[column];
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "boolean" || typeof val === "number") return val;
  const n = toNumber(val);
  return n === null ? null : n;
}

function evaluateRpn(row, rpn) {
  const stack = [];
  for (const token of rpn) {
    if (token.type === "number") {
      stack.push(token.value);
      continue;
    }
    if (token.type === "column") {
      const val = readColumnValue(row, token.value);
      if (val === null) return null;
      stack.push(val);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    switch (token.value) {
      case "+":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a + b);
        break;
      case "-":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a - b);
        break;
      case "*":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a * b);
        break;
      case "/":
        if (typeof a !== "number" || typeof b !== "number" || b === 0) return null;
        stack.push(a / b);
        break;
      case "==":
        stack.push(a === b);
        break;
      case "!=":
        stack.push(a !== b);
        break;
      case ">":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a > b);
        break;
      case "<":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a < b);
        break;
      case ">=":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a >= b);
        break;
      case "<=":
        if (typeof a !== "number" || typeof b !== "number") return null;
        stack.push(a <= b);
        break;
      case "&&":
        if (typeof a !== "boolean" || typeof b !== "boolean") return null;
        stack.push(a && b);
        break;
      case "||":
        if (typeof a !== "boolean" || typeof b !== "boolean") return null;
        stack.push(a || b);
        break;
      default:
        return null;
    }
  }
  if (stack.length !== 1) return null;
  const result = stack[0];
  if (typeof result === "number" && !Number.isFinite(result)) return null;
  if (typeof result === "number" || typeof result === "boolean") return result;
  return null;
}

function computeCalculatedColumn(row, definition) {
  const tokens = tokenizeExpression(definition.expression);
  if (!tokens) return null;
  const rpn = expressionToRpn(tokens);
  if (!rpn) return null;
  return evaluateRpn(row, rpn);
}

function extractColumnsFromExpression(expression) {
  const tokens = tokenizeExpression(expression);
  if (!tokens) return [];
  return [...new Set(tokens.filter((t) => t.type === "column").map((t) => t.value))];
}

function isValidCalculatedExpression(expression) {
  const tokens = tokenizeExpression(expression);
  if (!tokens || tokens.length === 0) return false;
  return !!expressionToRpn(tokens);
}

function createCalcId() {
  return `calc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCalculatedColumnRecord(definition) {
  if (!definition || typeof definition !== "object") return null;
  return {
    id: typeof definition.id === "string" ? definition.id : createCalcId(),
    name: typeof definition.name === "string" ? definition.name : "",
    expression: typeof definition.expression === "string" ? definition.expression : "",
    enabled: definition.enabled !== false,
  };
}

function normalizeCalculatedColumns(definitions) {
  if (!Array.isArray(definitions)) return [];
  return definitions.map(normalizeCalculatedColumnRecord).filter(Boolean);
}

function cloneCalculatedColumns(definitions) {
  return normalizeCalculatedColumns(definitions);
}

function getCalcColumnById(id) {
  return state.calculatedColumns.find((definition) => definition.id === id) || null;
}

function getCalcColumnDependents(name) {
  return state.calculatedColumns.filter(
    (definition) => definition.name !== name && extractColumnsFromExpression(definition.expression).includes(name),
  );
}

function getCalcReferenceColumns(definition = null) {
  const calcNames = new Set(state.calculatedColumns.map((item) => item.name).filter(Boolean));
  const base = state.availableColumns.filter((column) => !calcNames.has(column));
  const otherCalcs = state.calculatedColumns
    .filter((item) => item.id !== definition?.id && item.name)
    .map((item) => item.name);
  return [...new Set([...base, ...otherCalcs])].sort();
}

function isKnownCalcReference(column, definition) {
  if (!column) return false;
  if (column === definition?.name) return false;
  return getCalcReferenceColumns(definition).includes(column);
}

function sortCalculatedColumnsByDependency(columns) {
  const names = new Set(columns.map((definition) => definition.name));
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(definition) {
    if (visited.has(definition.name)) return true;
    if (visiting.has(definition.name)) return false;
    visiting.add(definition.name);
    for (const ref of extractColumnsFromExpression(definition.expression)) {
      if (!names.has(ref)) continue;
      const dependency = columns.find((item) => item.name === ref);
      if (dependency && !visit(dependency)) return false;
    }
    visiting.delete(definition.name);
    visited.add(definition.name);
    sorted.push(definition);
    return true;
  }

  for (const definition of columns) {
    if (!visit(definition)) return columns;
  }
  return sorted;
}

function calcExpressionYieldsValue(definition) {
  if (!isValidCalculatedExpression(definition.expression)) return false;
  const refs = extractColumnsFromExpression(definition.expression);
  const calcRefs = new Set(refs.filter((ref) => state.calculatedColumns.some((item) => item.name === ref)));
  const deps = sortCalculatedColumnsByDependency(
    state.calculatedColumns.filter((item) => item.name && calcRefs.has(item.name)),
  );

  for (const row of state.rows) {
    const working = { ...row };
    for (const dep of deps) {
      if (!isValidCalculatedExpression(dep.expression)) continue;
      working[dep.name] = computeCalculatedColumn(working, dep);
    }
    const result = computeCalculatedColumn(working, definition);
    if (typeof result === "number" && Number.isFinite(result)) return true;
    if (typeof result === "boolean") return true;
  }
  return false;
}

function calcNameConflicts(name, definition) {
  if (!name) return false;
  if (state.calculatedColumns.some((item) => item.id !== definition.id && item.name === name)) return true;
  const ownCurrentName = state.calculatedColumns.find((item) => item.id === definition.id)?.name;
  if (name === ownCurrentName) return false;
  if (CORE_COLUMNS.includes(name)) return true;
  if (!state.rows[0] || !(name in state.rows[0])) return false;
  return !state.calculatedColumns.some((item) => item.name === name);
}

function hasCalcCircularDependency(definition) {
  if (!definition?.name) return false;
  const names = new Set(state.calculatedColumns.map((item) => item.name).filter(Boolean));
  const visiting = new Set();
  const visited = new Set();

  function visit(name) {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    const current = state.calculatedColumns.find((item) => item.name === name);
    if (current) {
      for (const ref of extractColumnsFromExpression(current.expression)) {
        if (names.has(ref) && visit(ref)) return true;
      }
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  }

  return visit(definition.name);
}

function validateCalcDefinition(definition) {
  const errors = [];
  if (!definition) return { valid: false, errors: ["Invalid calculated attribute"] };

  const name = definition.name.trim();
  if (!name) {
    errors.push("Enter a name");
  } else if (calcNameConflicts(name, definition)) {
    errors.push("Name must be unique and cannot match an existing attribute");
  }

  const expression = definition.expression.trim();
  if (!expression) {
    errors.push("Enter a formula");
  } else if (!isValidCalculatedExpression(expression)) {
    errors.push("Syntax error");
  } else {
    for (const ref of extractColumnsFromExpression(expression)) {
      if (!isKnownCalcReference(ref, definition)) {
        errors.push(`Unknown attribute: ${ref}`);
      }
    }
    if (errors.length === 0 && !calcExpressionYieldsValue(definition)) {
      errors.push("Formula must yield a numeric or boolean value");
    }
    if (errors.length === 0 && hasCalcCircularDependency(definition)) {
      errors.push("Circular dependency detected");
    }
  }

  return { valid: errors.length === 0, errors };
}

function isCalcDefinitionComplete(definition) {
  return validateCalcDefinition(definition).valid;
}

function getActiveCalculatedColumns() {
  const active = state.calculatedColumns.filter((definition) => definition.enabled !== false && isCalcDefinitionComplete(definition));
  return sortCalculatedColumnsByDependency(active);
}

function normalizeLegacyCalculatedDefinitions() {
  state.calculatedColumns = state.calculatedColumns
    .map((definition) => {
      if (definition && typeof definition.expression === "string") {
        return normalizeCalculatedColumnRecord(definition);
      }
      if (definition && Array.isArray(definition.columns) && typeof definition.operation === "string") {
        if (definition.operation === "sum") {
          return normalizeCalculatedColumnRecord({
            name: definition.name,
            expression: definition.columns.map((c) => `{${c}}`).join(" + "),
            enabled: true,
          });
        }
        if (definition.operation === "diff") {
          return normalizeCalculatedColumnRecord({
            name: definition.name,
            expression: definition.columns.map((c) => `{${c}}`).join(" - "),
            enabled: true,
          });
        }
        if (definition.operation === "product") {
          return normalizeCalculatedColumnRecord({
            name: definition.name,
            expression: definition.columns.map((c) => `{${c}}`).join(" * "),
            enabled: true,
          });
        }
        if (definition.operation === "ratio" && definition.columns.length >= 2) {
          return normalizeCalculatedColumnRecord({
            name: definition.name,
            expression: `{${definition.columns[0]}} / {${definition.columns[1]}}`,
            enabled: true,
          });
        }
      }
      return null;
    })
    .filter(Boolean);
}

function recomputeCalculatedColumns() {
  for (const row of state.rows) {
    for (const definition of state.calculatedColumns) {
      delete row[definition.name];
    }
  }
  for (const row of state.rows) {
    for (const definition of getActiveCalculatedColumns()) {
      row[definition.name] = computeCalculatedColumn(row, definition);
    }
  }
}

function rebuildCalculatedRegistry() {
  for (const definition of state.calculatedColumns) {
    state.schemaRegistry.delete(definition.name);
  }
  for (const definition of getActiveCalculatedColumns()) {
    const sample = state.rows.find((row) => row[definition.name] !== undefined && row[definition.name] !== null)?.[
      definition.name
    ];
    const type = typeof sample === "boolean" ? "boolean" : "number";
    state.schemaRegistry.set(definition.name, {
      path: definition.name,
      type,
      presence: state.rows.length,
      sample: "",
    });
  }
}

function applyCalculatedColumnsUpdate() {
  recomputeCalculatedColumns();
  rebuildCalculatedRegistry();
  buildAvailableColumns();
  computeScalarColumnDisplayWidths();
  renderCalcTable();
  renderColumnChooser();
  state.visibleColumns = ensureRequiredVisibleColumns(
    state.visibleColumns.filter((column) => state.availableColumns.includes(column)),
  );
  applyFiltersAndSort();
  saveSessionState();
}

function removeCalculatedColumnById(id, { skipConfirm = false } = {}) {
  const definition = getCalcColumnById(id);
  if (!definition) return false;
  const dependents = getCalcColumnDependents(definition.name);
  if (!skipConfirm && dependents.length > 0) {
    const names = dependents.map((item) => item.name).join(", ");
    const message = `Deleting "${definition.name}" affects calculated attributes that depend on it: ${names}. Continue?`;
    if (!window.confirm(message)) return false;
  }

  state.calculatedColumns = state.calculatedColumns.filter((item) => item.id !== id);
  for (const row of state.rows) {
    delete row[definition.name];
  }
  if (state.editingCalcId === id) state.editingCalcId = null;
  if (state.focusCalcId === id) state.focusCalcId = null;
  state.visibleColumns = state.visibleColumns.filter((column) => column !== definition.name);
  applyCalculatedColumnsUpdate();
  if (state.visibleColumns.length === 0) {
    setVisibleColumns(CORE_COLUMNS);
  } else {
    setVisibleColumns(state.visibleColumns);
  }
  return true;
}

function applyFiltersAndSort() {
  const search = elements.searchInput.value.trim().toLowerCase();
  const faction = elements.factionFilter.value;
  const category = elements.categoryFilter.value;

  const filtered = state.rows
    .filter((row) => {
      if (faction && row.faction !== faction) return false;
      if (category && row.category !== category) return false;
      if (!search) return true;
      return (
        row.weaponName.toLowerCase().includes(search) ||
        row.faction.toLowerCase().includes(search) ||
        row.category.toLowerCase().includes(search)
      );
    })
    .filter((row) => rowMatchesActiveFilters(row));

  filtered.sort((a, b) => {
    const va = a[state.sortKey];
    const vb = b[state.sortKey];
    const cmp = compareValues(va, vb);
    return state.sortDirection === "asc" ? cmp : -cmp;
  });

  state.filteredRows = filtered;
  state.currentPage = 1;
  renderTable();
  updateAdvancedFiltersTriggerState();
  saveSessionState();
}

function renderTable() {
  if (state.visibleColumns.length === 0) {
    elements.tableHead.innerHTML = "";
    elements.pinnedTableBody.innerHTML = "";
    elements.tableBody.innerHTML = "";
    document.getElementById("statsTable")?.querySelector("colgroup")?.replaceChildren();
    elements.statusText.textContent = "No attributes selected. Pick attributes above.";
    elements.pageText.textContent = "Page 1 / 1";
    return;
  }

  const totalRows = state.filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / state.rowsPerPage));
  state.currentPage = Math.min(state.currentPage, totalPages);
  const start = (state.currentPage - 1) * state.rowsPerPage;
  const pageRows = state.filteredRows.slice(start, start + state.rowsPerPage);

  renderMultiRowHeader(state.visibleColumns);
  applyTableColumnWidths();

  state.pinnedRowKeys = state.pinnedRowKeys.filter((key) => findRowByKey(key));

  elements.pinnedTableBody.innerHTML = "";
  elements.tableBody.innerHTML = "";

  const pinnedKeySet = new Set(state.pinnedRowKeys);
  const pinnedRows = state.pinnedRowKeys.map((key) => findRowByKey(key)).filter(Boolean);

  for (const row of pinnedRows) {
    elements.pinnedTableBody.appendChild(createTableRow(row, { pinned: true }));
  }

  for (const row of pageRows) {
    if (pinnedKeySet.has(getRowKey(row))) continue;
    elements.tableBody.appendChild(createTableRow(row, { pinned: false }));
  }

  const pinnedCount = pinnedRows.length;
  const pageCount = pageRows.length - pageRows.filter((row) => pinnedKeySet.has(getRowKey(row))).length;
  const statusParts = [`Showing ${pageCount} of ${totalRows} filtered rows (${state.rows.length} total weapons)`];
  if (pinnedCount) statusParts.push(`${pinnedCount} pinned`);
  elements.statusText.textContent = statusParts.join(" · ");
  elements.pageText.textContent = `Page ${state.currentPage} / ${totalPages}`;
  elements.prevPageBtn.disabled = state.currentPage <= 1;
  elements.nextPageBtn.disabled = state.currentPage >= totalPages;
  updateSortIndicators();
  requestAnimationFrame(updateTableLayoutVars);
}

function updateSortIndicators() {
  const headers = Array.from(elements.tableHead.querySelectorAll("th.header-leaf[data-key]"));
  for (const th of headers) {
    const key = th.dataset.key;
    th.textContent = th.dataset.label || th.textContent;
    if (key === state.sortKey) {
      const span = document.createElement("span");
      span.className = "sort-indicator";
      span.textContent = state.sortDirection === "asc" ? "▲" : "▼";
      th.appendChild(span);
    }
  }
}

function isAttributeGroupExpanded(group, autoExpand) {
  if (autoExpand) return true;
  return !state.collapsedColumnGroups.has(group);
}

function toggleAttributeGroup(group) {
  if (state.collapsedColumnGroups.has(group)) {
    state.collapsedColumnGroups.delete(group);
  } else {
    state.collapsedColumnGroups.add(group);
  }
  renderAttributeChooser();
}

function setAllAttributeGroupsExpanded(expanded) {
  state.collapsedColumnGroups.clear();
  if (!expanded) {
    for (const group of state.groupedColumns.keys()) {
      state.collapsedColumnGroups.add(group);
    }
  }
  renderAttributeChooser();
}

function buildAttributeSummary(attributes) {
  const labels = attributes.map((attr) => {
    const parts = attr.split(".");
    return parts[parts.length - 1] || attr;
  });
  if (labels.length <= 6) return labels.join(", ");
  return `${labels.slice(0, 6).join(", ")} (+${labels.length - 6} more)`;
}

function setGroupCheckboxState(checkbox, selectedCount, totalCount) {
  checkbox.checked = selectedCount === totalCount && totalCount > 0;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < totalCount;
}

function applyGroupSelection(groupAttributes, selectAll) {
  if (selectAll) {
    addVisibleColumnsInDefaultOrder(groupAttributes);
  } else {
    const remove = new Set(groupAttributes.filter((attr) => attr !== REQUIRED_VISIBLE_COLUMN));
    setVisibleColumns(state.visibleColumns.filter((attr) => !remove.has(attr)));
  }
}

function createGroupToggleBtn(group, expanded) {
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "attribute-toggle-btn";
  toggleBtn.textContent = expanded ? "▾" : "▸";
  toggleBtn.title = expanded ? "Collapse group" : "Expand group";
  toggleBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleAttributeGroup(group);
  });
  return toggleBtn;
}

function createGroupCell(group, groupAttributes, expanded) {
  const selectedCount = groupAttributes.filter((attr) => state.visibleColumns.includes(attr)).length;
  const td = document.createElement("td");
  td.className = "attribute-group-cell";

  const inner = document.createElement("div");
  inner.className = "attribute-group-cell-inner";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "attribute-group-checkbox";
  setGroupCheckboxState(checkbox, selectedCount, groupAttributes.length);
  checkbox.title = "Select all attributes in this group";
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.addEventListener("change", () => {
    applyGroupSelection(groupAttributes, checkbox.checked);
  });

  const name = document.createElement("span");
  name.className = "attribute-group-name";
  name.textContent = group;

  const count = document.createElement("span");
  count.className = "attribute-group-count";
  count.textContent = `${selectedCount}/${groupAttributes.length}`;

  inner.appendChild(checkbox);
  inner.appendChild(name);
  inner.appendChild(count);
  inner.appendChild(createGroupToggleBtn(group, expanded));
  td.appendChild(inner);
  return td;
}

function createAttributeItemRow(attribute) {
  const td = document.createElement("td");
  td.className = "attribute-item-cell";

  const label = document.createElement("label");
  label.className = "attribute-item";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.visibleColumns.includes(attribute);
  const isRequired = attribute === REQUIRED_VISIBLE_COLUMN;
  if (isRequired) {
    checkbox.checked = true;
    checkbox.disabled = true;
    checkbox.title = "Weapon name is always shown";
  }
  checkbox.addEventListener("change", () => {
    if (isRequired) {
      checkbox.checked = true;
      return;
    }
    if (checkbox.checked) {
      if (!state.visibleColumns.includes(attribute)) {
        addVisibleColumnsInDefaultOrder([attribute]);
      }
    } else {
      setVisibleColumns(state.visibleColumns.filter((attr) => attr !== attribute));
    }
  });

  const text = document.createElement("span");
  text.className = "attribute-item-label";
  const info = state.schemaRegistry.get(attribute);
  const coverage = info ? Math.round((info.presence / state.rows.length) * 100) : 100;
  text.title = attribute;
  text.textContent = `${attribute} (${coverage}%)`;

  label.appendChild(checkbox);
  label.appendChild(text);
  td.appendChild(label);
  return td;
}

function renderAttributeChooser() {
  const query = elements.attributeSearchInput.value.trim().toLowerCase();
  const autoExpand = Boolean(query);
  const tbody = elements.attributeChooserBody;
  tbody.innerHTML = "";

  for (const [group, attributes] of state.groupedColumns.entries()) {
    const shownAttributes = attributes.filter((attr) => !query || attr.toLowerCase().includes(query));
    if (shownAttributes.length === 0) continue;

    const expanded = isAttributeGroupExpanded(group, autoExpand);

    if (!expanded) {
      const tr = document.createElement("tr");
      tr.className = "attribute-group-row is-collapsed";

      const groupCell = createGroupCell(group, shownAttributes, false);
      const summaryCell = document.createElement("td");
      summaryCell.className = "attribute-summary-cell";
      summaryCell.title = shownAttributes.join("\n");
      summaryCell.textContent = buildAttributeSummary(shownAttributes);
      summaryCell.addEventListener("click", () => toggleAttributeGroup(group));

      tr.appendChild(groupCell);
      tr.appendChild(summaryCell);
      tbody.appendChild(tr);
      continue;
    }

    shownAttributes.forEach((attribute, index) => {
      const tr = document.createElement("tr");
      tr.className = "attribute-group-row is-expanded";

      if (index === 0) {
        tr.appendChild(createGroupCell(group, shownAttributes, true));
      } else {
        const spacer = document.createElement("td");
        spacer.className = "attribute-group-cell attribute-group-cell--continued";
        tr.appendChild(spacer);
      }

      tr.appendChild(createAttributeItemRow(attribute));
      tbody.appendChild(tr);
    });
  }
}

function renderColumnChooser() {
  renderAttributeChooser();
}

function createFilterId() {
  return `filter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createClauseId() {
  return `clause_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeClauseRecord(clause) {
  if (!clause || typeof clause !== "object") return null;
  return {
    id: typeof clause.id === "string" ? clause.id : createClauseId(),
    joinOperator: clause.joinOperator === "or" ? "or" : "and",
    mode: clause.mode === "column" ? "column" : "value",
    column: typeof clause.column === "string" ? clause.column : "",
    operator: typeof clause.operator === "string" ? clause.operator : "",
    value1: clause.value1 != null ? String(clause.value1) : "",
    value2: clause.value2 != null ? String(clause.value2) : "",
    compareColumn: typeof clause.compareColumn === "string" ? clause.compareColumn : "",
  };
}

function createEmptyClause({ joinOperator = "and" } = {}) {
  return normalizeClauseRecord({
    id: createClauseId(),
    joinOperator,
    column: "",
    operator: "",
    mode: "value",
    value1: "",
    value2: "",
    compareColumn: "",
  });
}

function normalizeFilterRecord(filter) {
  if (!filter || typeof filter !== "object") return null;
  const id = typeof filter.id === "string" ? filter.id : createFilterId();
  const enabled = filter.enabled !== false;
  const nextJoinOperator = filter.nextJoinOperator === "or" ? "or" : "and";
  const joinToggleSelected = filter.joinToggleSelected === true;

  let record;
  if (Array.isArray(filter.clauses) && filter.clauses.length > 0) {
    record = {
      id,
      enabled,
      nextJoinOperator,
      joinToggleSelected,
      clauses: filter.clauses.map(normalizeClauseRecord).filter(Boolean),
    };
  } else {
    record = {
      id,
      enabled,
      nextJoinOperator,
      joinToggleSelected,
      clauses: [
        normalizeClauseRecord({
          id: createClauseId(),
          joinOperator: "and",
          mode: filter.mode,
          column: filter.column || "",
          operator: filter.operator || "",
          value1: filter.value1,
          value2: filter.value2,
          compareColumn: filter.compareColumn,
        }),
      ],
    };
  }

  if (!isFilterGroupComplete(record)) {
    record.enabled = false;
  }
  return record;
}

function normalizeActiveFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters.map(normalizeFilterRecord).filter(Boolean);
}

function operatorNeedsRhs(operator) {
  return !["is_empty", "is_not_empty"].includes(operator);
}

function isClauseComplete(clause) {
  return validateClause(clause).valid;
}

function clauseHasPartialData(clause) {
  if (!clause) return false;
  return Boolean(
    clause.column ||
      clause.operator ||
      clause.value1 ||
      clause.value2 ||
      clause.compareColumn,
  );
}

function validateClause(clause) {
  const errors = [];
  if (!clause) {
    return { valid: false, errors: ["Invalid clause"] };
  }

  if (!clause.column) {
    errors.push("Select an attribute");
  }

  if (!clause.operator) {
    errors.push("Select an operator");
  } else if (operatorNeedsRhs(clause.operator)) {
    if (clause.mode === "column") {
      if (!clause.compareColumn) {
        errors.push("Select a compare attribute");
      }
    } else if (clause.operator === "between") {
      if (!clause.value1) errors.push("Enter a minimum value");
      if (!clause.value2) errors.push("Enter a maximum value");
    } else if (clause.column && getColumnType(clause.column) === "boolean") {
      const lower = (clause.value1 || "").toLowerCase();
      if (lower !== "true" && lower !== "false") {
        errors.push("Enter true or false");
      }
    } else if (!clause.value1) {
      errors.push("Enter a value");
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateFilterGroup(filter) {
  if (!filter?.clauses?.length) {
    return { valid: false, errors: ["Add at least one clause"] };
  }

  const clauseResults = filter.clauses.map((clause) => ({
    clauseId: clause.id,
    ...validateClause(clause),
  }));
  const valid = clauseResults.every((result) => result.valid);
  const errors = valid
    ? []
    : ["Complete every clause before activating this filter"];

  return { valid, errors, clauseResults };
}

function isFilterGroupComplete(filter) {
  return validateFilterGroup(filter).valid;
}

function getApplicableFilters() {
  return state.activeFilters.filter((filter) => filter.enabled !== false && isFilterGroupComplete(filter));
}

function updateAdvancedFiltersTriggerState() {
  const trigger = document.querySelector('.drawer-trigger[data-drawer-panel="filters"]');
  if (!trigger) return;
  const hasActive = getApplicableFilters().length > 0;
  trigger.classList.toggle("has-applied-filters", hasActive);
}

function syncClauseValidation(clauseEl, clause, isEditing) {
  const { valid, errors } = validateClause(clause);
  const showHint = !valid && (isEditing || clauseHasPartialData(clause));
  const errorSet = new Set(errors);

  clauseEl.classList.toggle("is-draft", !valid);

  let errorEl = clauseEl.querySelector(".filter-clause-error");
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.className = "filter-clause-error";
    errorEl.setAttribute("role", "alert");
    clauseEl.appendChild(errorEl);
  }
  errorEl.hidden = !showHint;
  errorEl.textContent = showHint ? errors.join(" · ") : "";

  clauseEl.querySelector(".filter-column-picker")?.classList.toggle("is-invalid", showHint && errorSet.has("Select an attribute"));
  clauseEl.querySelector(".filter-operator-picker")?.classList.toggle("is-invalid", showHint && errorSet.has("Select an operator"));
  clauseEl.querySelector(".filter-value-input-1")?.classList.toggle(
    "is-invalid",
    showHint &&
      (errorSet.has("Enter a value") ||
        errorSet.has("Enter true or false") ||
        errorSet.has("Enter a minimum value")),
  );
  clauseEl.querySelector(".filter-value-input-2")?.classList.toggle(
    "is-invalid",
    showHint && errorSet.has("Enter a maximum value"),
  );
  clauseEl.querySelector(".filter-compare-picker")?.classList.toggle(
    "is-invalid",
    showHint && errorSet.has("Select a compare attribute"),
  );
}

function syncFilterActivationState(tr, filter, activeCheckbox) {
  const canActivate = isFilterGroupComplete(filter);

  if (!canActivate && filter.enabled !== false) {
    filter.enabled = false;
  }

  tr.classList.toggle("is-draft", !canActivate);
  activeCheckbox.disabled = !canActivate;
  activeCheckbox.checked = filter.enabled !== false;
  activeCheckbox.title = canActivate ? "Activate filter" : "Complete all clauses to activate";
}

function rowMatchesFilterGroup(row, filter) {
  const clauses = filter.clauses;
  if (clauses.length === 0) return true;

  let result = matchesFilter(row, clauses[0]);
  for (let i = 1; i < clauses.length; i += 1) {
    const match = matchesFilter(row, clauses[i]);
    if (clauses[i].joinOperator === "or") {
      result = result || match;
    } else {
      result = result && match;
    }
  }
  return result;
}

function rowMatchesActiveFilters(row) {
  const applicable = getApplicableFilters();
  if (applicable.length === 0) return true;
  return applicable.every((filter) => rowMatchesFilterGroup(row, filter));
}

function getFilterById(id) {
  return state.activeFilters.find((filter) => filter.id === id) || null;
}

function getClauseById(filter, clauseId) {
  return filter?.clauses.find((clause) => clause.id === clauseId) || null;
}

function updateFilterById(id, patch) {
  const filter = getFilterById(id);
  if (!filter) return;
  Object.assign(filter, patch);
}

function updateClauseById(filterId, clauseId, patch) {
  const filter = getFilterById(filterId);
  const clause = getClauseById(filter, clauseId);
  if (!clause) return;
  Object.assign(clause, patch);
}

function removeClauseById(filterId, clauseId) {
  const filter = getFilterById(filterId);
  if (!filter) return;
  if (filter.clauses.length <= 1) {
    removeFilterById(filterId);
    return;
  }
  filter.clauses = filter.clauses.filter((clause) => clause.id !== clauseId);
  if (state.focusClauseId === clauseId) state.focusClauseId = null;
}

function removeFilterById(id) {
  const removed = getFilterById(id);
  const removedClauseIds = removed ? removed.clauses.map((clause) => clause.id) : [];
  state.activeFilters = state.activeFilters.filter((filter) => filter.id !== id);
  if (state.focusFilterId === id) state.focusFilterId = null;
  if (state.editingFilterId === id) state.editingFilterId = null;
  if (state.focusClauseId && removedClauseIds.includes(state.focusClauseId)) {
    state.focusClauseId = null;
  }
}

function getComparableColumns(baseColumn) {
  const baseType = getColumnType(baseColumn);
  return state.availableColumns.filter((column) => column !== baseColumn && getColumnType(column) === baseType);
}

function filterOperatorsForType(type, mode) {
  if (mode === "column") {
    if (type === "number") {
      return [
        ["eq", "="],
        ["neq", "!="],
        ["gt", ">"],
        ["gte", ">="],
        ["lt", "<"],
        ["lte", "<="],
      ];
    }
    return [
      ["eq", "="],
      ["neq", "!="],
    ];
  }

  if (type === "number") {
    return [
      ["eq", "="],
      ["neq", "!="],
      ["gt", ">"],
      ["gte", ">="],
      ["lt", "<"],
      ["lte", "<="],
      ["between", "between"],
      ["is_empty", "is empty"],
      ["is_not_empty", "is not empty"],
    ];
  }
  if (type === "boolean") {
    return [
      ["eq", "="],
      ["neq", "!="],
      ["is_empty", "is empty"],
      ["is_not_empty", "is not empty"],
    ];
  }
  return [
    ["contains", "contains"],
    ["not_contains", "not contains"],
    ["eq", "="],
    ["neq", "!="],
    ["is_empty", "is empty"],
    ["is_not_empty", "is not empty"],
  ];
}

function fillSelect(select, options, { selected = "", placeholder = null } = {}) {
  select.innerHTML = "";
  if (placeholder != null) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.appendChild(option);
  }
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  if (selected && [...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function fuzzyMatchAttribute(text, query) {
  if (!query) return true;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  if (hay.includes(needle)) return true;
  let qi = 0;
  for (let i = 0; i < hay.length && qi < needle.length; i += 1) {
    if (hay[i] === needle[qi]) qi += 1;
  }
  return qi === needle.length;
}

function filterAttributeColumns(columns, query) {
  const needle = query.trim();
  if (!needle) return columns;
  const filtered = columns.filter((column) => fuzzyMatchAttribute(column, needle));
  const q = needle.toLowerCase();
  return filtered.sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const rank = (value) => {
      if (value.startsWith(q)) return 0;
      if (value.includes(q)) return 1;
      return 2;
    };
    const diff = rank(al) - rank(bl);
    return diff !== 0 ? diff : al.localeCompare(bl);
  });
}

function filterOptionRows(options, query) {
  const needle = query.trim();
  if (!needle) return options;
  const filtered = options.filter(
    ([value, label]) => fuzzyMatchAttribute(label, needle) || fuzzyMatchAttribute(value, needle),
  );
  const q = needle.toLowerCase();
  return filtered.sort((a, b) => {
    const al = a[1].toLowerCase();
    const bl = b[1].toLowerCase();
    const rank = (text) => {
      if (text.startsWith(q)) return 0;
      if (text.includes(q)) return 1;
      return 2;
    };
    const diff = rank(al) - rank(bl);
    return diff !== 0 ? diff : al.localeCompare(bl);
  });
}

function getOptionLabel(options, value) {
  if (!value) return "";
  const match = options.find(([optionValue]) => optionValue === value);
  return match ? match[1] : value;
}

function createSearchableOptionPicker({
  className = "",
  placeholder = "Select...",
  getOptions = () => [],
  filterOptions = filterOptionRows,
  selected = "",
  onSelect,
  disabled = false,
}) {
  const root = document.createElement("div");
  root.className = `searchable-option-picker searchable-attribute-picker ${className}`.trim();

  const input = document.createElement("input");
  input.type = "text";
  input.className = "searchable-attribute-input";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.disabled = disabled;

  const list = document.createElement("ul");
  list.className = "searchable-attribute-list";
  list.hidden = true;

  root.dataset.value = selected || "";
  input.value = selected ? getOptionLabel(getOptions(), selected) : "";
  if (!input.value && selected) input.value = selected;

  let highlightedIndex = -1;
  let repositionListenersAttached = false;
  let committedValue = selected || "";

  const getDisplayForValue = (value) => {
    if (!value) return "";
    return getOptionLabel(getOptions(), value) || value;
  };

  const clearFloatingListStyles = () => {
    list.style.position = "";
    list.style.left = "";
    list.style.top = "";
    list.style.bottom = "";
    list.style.width = "";
    list.style.maxHeight = "";
    list.style.zIndex = "";
  };

  const positionFloatingList = () => {
    if (list.hidden) return;
    const rect = input.getBoundingClientRect();
    const gap = 4;
    const viewportPadding = 8;
    const preferredMaxHeight = 224;
    const minHeight = 80;

    const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const spaceAbove = rect.top - gap - viewportPadding;
    const openUpward = spaceBelow < minHeight && spaceAbove > spaceBelow;
    const availableSpace = Math.max(openUpward ? spaceAbove : spaceBelow, minHeight);
    let maxHeight = Math.min(preferredMaxHeight, availableSpace);

    list.style.position = "fixed";
    list.style.left = `${Math.max(
      viewportPadding,
      Math.min(rect.left, window.innerWidth - rect.width - viewportPadding),
    )}px`;
    list.style.width = `${rect.width}px`;
    list.style.maxHeight = `${maxHeight}px`;
    list.style.zIndex = "110";

    if (openUpward) {
      let top = rect.top - gap - maxHeight;
      if (top < viewportPadding) {
        maxHeight = Math.max(minHeight, rect.top - gap - viewportPadding);
        top = viewportPadding;
        list.style.maxHeight = `${maxHeight}px`;
      }
      list.style.top = `${top}px`;
      list.style.bottom = "";
    } else {
      list.style.top = `${rect.bottom + gap}px`;
      list.style.bottom = "";
      const bottomEdge = rect.bottom + gap + maxHeight;
      if (bottomEdge > window.innerHeight - viewportPadding) {
        maxHeight = Math.max(minHeight, window.innerHeight - viewportPadding - rect.bottom - gap);
        list.style.maxHeight = `${maxHeight}px`;
      }
    }
  };

  const attachRepositionListeners = () => {
    if (repositionListenersAttached) return;
    repositionListenersAttached = true;
    window.addEventListener("scroll", positionFloatingList, true);
    window.addEventListener("resize", positionFloatingList);
  };

  const detachRepositionListeners = () => {
    if (!repositionListenersAttached) return;
    repositionListenersAttached = false;
    window.removeEventListener("scroll", positionFloatingList, true);
    window.removeEventListener("resize", positionFloatingList);
  };

  const hideFloatingList = () => {
    list.hidden = true;
    highlightedIndex = -1;
    detachRepositionListeners();
    list.classList.remove("is-floating");
    clearFloatingListStyles();
    if (list.parentElement === document.body) {
      root.appendChild(list);
    }
  };

  const showFloatingList = () => {
    list.hidden = false;
    if (list.parentElement !== document.body) {
      document.body.appendChild(list);
    }
    list.classList.add("is-floating");
    positionFloatingList();
    attachRepositionListeners();
  };

  const getListOptions = () => [...list.querySelectorAll(".searchable-attribute-option")];

  const setHighlightedIndex = (nextIndex) => {
    const options = getListOptions();
    if (options.length === 0) {
      highlightedIndex = -1;
      return;
    }
    highlightedIndex = ((nextIndex % options.length) + options.length) % options.length;
    options.forEach((option, index) => {
      option.classList.toggle("is-highlighted", index === highlightedIndex);
    });
    options[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  };

  const focusNextControlInRow = () => {
    const controls = input.closest(".filter-row-controls");
    if (!controls) return;

    const focusables = [
      ...controls.querySelectorAll(".searchable-attribute-input"),
      ...controls.querySelectorAll("input.filter-value-input"),
    ].filter((el) => {
      if (el.disabled) return false;
      const picker = el.closest(".searchable-attribute-picker");
      if (picker && window.getComputedStyle(picker).display === "none") return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });

    const currentIndex = focusables.indexOf(input);
    if (currentIndex < 0 || currentIndex >= focusables.length - 1) return;

    const next = focusables[currentIndex + 1];
    next.focus();
    if (next.tagName === "INPUT" && typeof next.select === "function") {
      next.select();
    }
  };

  const findOptionMatch = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const options = getOptions();
    return (
      options.find(
        ([value, label]) =>
          label.toLowerCase() === trimmed.toLowerCase() || value.toLowerCase() === trimmed.toLowerCase(),
      ) || null
    );
  };

  const getFilterQuery = () => (root.dataset.value ? "" : input.value);

  const renderList = () => {
    const matches = filterOptions(getOptions(), getFilterQuery());
    list.innerHTML = "";
    highlightedIndex = -1;
    if (matches.length === 0) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "searchable-attribute-empty";
      emptyItem.textContent = "No matches";
      list.appendChild(emptyItem);
      if (!list.hidden) requestAnimationFrame(positionFloatingList);
      return;
    }
    for (const [value, label] of matches.slice(0, 100)) {
      const item = document.createElement("li");
      item.className = "searchable-attribute-option";
      item.textContent = label;
      item.dataset.value = value;
      if (value === root.dataset.value) item.classList.add("is-selected");
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectOption(value);
      });
      list.appendChild(item);
    }
    if (!list.hidden) requestAnimationFrame(positionFloatingList);
  };

  const selectOption = (value, { focusNext = false } = {}) => {
    root.dataset.value = value;
    input.value = getDisplayForValue(value);
    committedValue = value;
    hideFloatingList();
    onSelect?.(value);
    if (focusNext) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          focusNextControlInRow();
        });
      });
    }
  };

  const openList = () => {
    if (input.disabled) return;
    renderList();
    showFloatingList();
  };

  const commitInputValue = () => {
    const options = getOptions();
    const trimmed = input.value.trim();

    if (root.dataset.value && options.some(([value]) => value === root.dataset.value)) {
      input.value = getDisplayForValue(root.dataset.value);
      return;
    }

    if (trimmed === "") {
      if (committedValue !== "") {
        root.dataset.value = "";
        input.value = "";
        committedValue = "";
        onSelect?.("");
      } else {
        input.value = "";
      }
      return;
    }

    const matched = findOptionMatch(trimmed);
    if (matched) {
      const [value] = matched;
      if (value !== committedValue) {
        selectOption(value);
      } else {
        root.dataset.value = value;
        input.value = getDisplayForValue(value);
      }
      return;
    }

    root.dataset.value = committedValue;
    input.value = getDisplayForValue(committedValue);
  };

  const closeList = () => {
    hideFloatingList();
    commitInputValue();
  };

  input.addEventListener("focus", () => {
    if (input.disabled) return;
    committedValue = root.dataset.value || "";
    openList();
  });
  input.addEventListener("input", () => {
    if (input.disabled) return;
    root.dataset.value = "";
    openList();
  });
  input.addEventListener("blur", () => {
    window.setTimeout(closeList, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (input.disabled) return;

    const options = getListOptions();
    const listIsOpen = !list.hidden && options.length > 0;

    if (event.key === "Tab" && listIsOpen) {
      event.preventDefault();
      if (event.shiftKey) {
        setHighlightedIndex(highlightedIndex <= 0 ? options.length - 1 : highlightedIndex - 1);
      } else {
        setHighlightedIndex(highlightedIndex < 0 ? 0 : highlightedIndex + 1);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.hidden) openList();
      const nextOptions = getListOptions();
      if (nextOptions.length === 0) return;
      setHighlightedIndex(highlightedIndex < 0 ? 0 : highlightedIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextOptions = getListOptions();
      if (nextOptions.length === 0) return;
      setHighlightedIndex(highlightedIndex < 0 ? nextOptions.length - 1 : highlightedIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlightedIndex >= 0 && options[highlightedIndex]) {
        selectOption(options[highlightedIndex].dataset.value, { focusNext: true });
      } else if (options.length === 1) {
        selectOption(options[0].dataset.value, { focusNext: true });
      } else {
        const matched = findOptionMatch(input.value);
        if (matched) selectOption(matched[0], { focusNext: true });
      }
    } else if (event.key === "Escape") {
      closeList();
      input.blur();
    }
  });

  root.setValue = (value) => {
    root.dataset.value = value || "";
    input.value = getDisplayForValue(value);
    committedValue = value || "";
  };
  root.getValue = () => root.dataset.value || "";
  root.setDisabled = (nextDisabled) => {
    input.disabled = nextDisabled;
    if (nextDisabled) closeList();
  };
  root.setPlaceholder = (nextPlaceholder) => {
    input.placeholder = nextPlaceholder;
  };
  root.focusInput = () => {
    input.focus();
    input.select();
  };
  root.refresh = () => {
    if (root.dataset.value) {
      input.value = getDisplayForValue(root.dataset.value);
    }
    if (!list.hidden) {
      renderList();
      positionFloatingList();
    }
  };

  root.closeList = closeList;

  root.append(input, list);
  return root;
}

function createSearchableAttributePicker({
  className = "",
  placeholder = "Select attribute...",
  getColumns = () => state.availableColumns,
  selected = "",
  onSelect,
  disabled = false,
}) {
  return createSearchableOptionPicker({
    className,
    placeholder,
    selected,
    onSelect,
    disabled,
    getOptions: () => getColumns().map((column) => [column, column]),
    filterOptions: (options, query) => {
      const columns = options.map(([value]) => value);
      return filterAttributeColumns(columns, query).map((column) => [column, column]);
    },
  });
}

function syncClauseControls(clause, clauseEl) {
  const columnPicker = clauseEl.querySelector(".filter-column-picker");
  const operatorPicker = clauseEl.querySelector(".filter-operator-picker");
  const modePicker = clauseEl.querySelector(".filter-mode-picker");
  const value1Input = clauseEl.querySelector(".filter-value-input-1");
  const value2Input = clauseEl.querySelector(".filter-value-input-2");
  const comparePicker = clauseEl.querySelector(".filter-compare-picker");
  const type = clause.column ? getColumnType(clause.column) : "string";
  const hasColumn = Boolean(clause.column);
  const ops = hasColumn ? filterOperatorsForType(type, clause.mode) : [];
  const operator = clause.operator && ops.some(([value]) => value === clause.operator) ? clause.operator : "";

  columnPicker?.setValue(clause.column);

  operatorPicker?.setDisabled(!hasColumn);
  operatorPicker?.setPlaceholder(hasColumn ? "Select operator..." : "Operator...");
  operatorPicker?.setValue(operator);
  operatorPicker?.refresh();

  const needsRhs = hasColumn && clause.operator && operatorNeedsRhs(clause.operator);
  modePicker.style.display = needsRhs ? "" : "none";
  modePicker?.setDisabled(!needsRhs);
  if (needsRhs) {
    modePicker?.setValue(clause.mode === "column" ? "column" : "value");
  } else {
    modePicker?.setValue("");
  }
  modePicker?.refresh();

  const showValue = needsRhs && clause.mode === "value";
  const showCompare = needsRhs && clause.mode === "column";
  value1Input.style.display = showValue ? "" : "none";
  value2Input.style.display = showValue && clause.operator === "between" ? "" : "none";
  comparePicker.style.display = showCompare ? "" : "none";

  if (showValue) {
    if (type === "number") {
      value1Input.type = "number";
      value2Input.type = "number";
      value1Input.placeholder = "value";
      value2Input.placeholder = "max";
    } else {
      value1Input.type = "text";
      value2Input.type = "text";
      value1Input.placeholder = type === "boolean" ? "true / false" : "value";
      value2Input.placeholder = "max";
    }
    value1Input.value = clause.value1;
    value2Input.value = clause.value2;
  }

  if (showCompare) {
    comparePicker?.setValue(clause.compareColumn);
    comparePicker?.refresh();
  }
}

const FILTER_ADD_CLAUSE_ICON = `<svg class="filter-add-clause-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 8v8M8 12h8"/></svg>`;

const FILTER_DELETE_ICON = `<svg class="filter-delete-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7 4v6m4-6v6M6 7l1 12a1 1 0 0 0 1 .93h8a1 1 0 0 0 1-.93L18 7"/></svg>`;

function syncFilterJoinOperatorFromClauses(filter) {
  if (filter.clauses.length > 1) {
    filter.nextJoinOperator = filter.clauses[filter.clauses.length - 1].joinOperator === "or" ? "or" : "and";
  }
}

function createFilterJoinToggle(filter, commitGroup) {
  syncFilterJoinOperatorFromClauses(filter);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "filter-join-toggle";
  button.title = "Choose how clauses combine";

  const andOpt = document.createElement("span");
  andOpt.className = "filter-join-opt";
  andOpt.textContent = "and";
  const sep = document.createElement("span");
  sep.className = "filter-join-sep";
  sep.textContent = " / ";
  const orOpt = document.createElement("span");
  orOpt.className = "filter-join-opt";
  orOpt.textContent = "or";

  const refresh = () => {
    andOpt.classList.toggle("is-active", filter.joinToggleSelected && filter.nextJoinOperator === "and");
    orOpt.classList.toggle("is-active", filter.joinToggleSelected && filter.nextJoinOperator === "or");
  };
  refresh();

  const selectJoin = (operator, event) => {
    event.stopPropagation();
    filter.nextJoinOperator = operator;
    filter.joinToggleSelected = true;
    if (filter.clauses.length > 1) {
      filter.clauses[filter.clauses.length - 1].joinOperator = operator;
    }
    refresh();
    applyFiltersAndSort();
    saveSessionState();
    renderFilterTable();
    commitGroup?.();
  };

  andOpt.addEventListener("click", (event) => selectJoin("and", event));
  orOpt.addEventListener("click", (event) => selectJoin("or", event));

  button.append(andOpt, sep, orOpt);
  return button;
}

function createClauseBlock(filter, clause, clauseIndex, tr, commitGroup) {
  const isEditing = state.editingFilterId === filter.id;
  const isLastClause = clauseIndex === filter.clauses.length - 1;
  const block = document.createElement("div");
  block.className = `filter-clause-block${isClauseComplete(clause) ? "" : " is-draft"}`;
  block.dataset.clauseId = clause.id;

  if (clauseIndex > 0) {
    const joinLabel = document.createElement("div");
    joinLabel.className = "filter-clause-join-label";
    joinLabel.textContent = clause.joinOperator;
    if (isEditing) {
      joinLabel.classList.add("is-editable");
      joinLabel.title = "Click to toggle and / or";
      joinLabel.addEventListener("click", (event) => {
        event.stopPropagation();
        clause.joinOperator = clause.joinOperator === "or" ? "and" : "or";
        joinLabel.textContent = clause.joinOperator;
        if (clauseIndex === filter.clauses.length - 1) {
          filter.nextJoinOperator = clause.joinOperator;
          filter.joinToggleSelected = true;
        }
        applyFiltersAndSort();
        saveSessionState();
      });
    }
    block.appendChild(joinLabel);
  }

  const clauseRow = document.createElement("div");
  clauseRow.className = "filter-clause-row";

  const controls = document.createElement("div");
  controls.className = "filter-row-controls";

  const columnPicker = createSearchableAttributePicker({
    className: "filter-column-picker",
    placeholder: "Select attribute...",
    selected: clause.column,
    onSelect: (column) => {
      updateClauseById(filter.id, clause.id, {
        column,
        operator: "",
        mode: "value",
        value1: "",
        value2: "",
        compareColumn: "",
      });
      syncClauseControls(clause, block);
      commitGroup();
    },
  });

  const operatorPicker = createSearchableOptionPicker({
    className: "filter-operator-picker",
    placeholder: "Operator...",
    selected: clause.operator,
    disabled: !clause.column,
    getOptions: () => {
      if (!clause.column) return [];
      const columnType = getColumnType(clause.column);
      return filterOperatorsForType(columnType, clause.mode);
    },
    onSelect: (operator) => {
      updateClauseById(filter.id, clause.id, {
        operator,
        value1: "",
        value2: "",
        compareColumn: "",
      });
      syncClauseControls(clause, block);
      commitGroup();
    },
  });

  const modePicker = createSearchableOptionPicker({
    className: "filter-mode-picker",
    placeholder: "Compare to...",
    selected: clause.mode === "column" ? "column" : clause.mode === "value" ? "value" : "",
    getOptions: () => [
      ["value", "Compare to value"],
      ["column", "Compare to attribute"],
    ],
    onSelect: (mode) => {
      updateClauseById(filter.id, clause.id, {
        mode: mode === "column" ? "column" : "value",
        value1: "",
        value2: "",
        compareColumn: "",
      });
      syncClauseControls(clause, block);
      commitGroup();
    },
  });

  const value1Input = document.createElement("input");
  value1Input.className = "filter-value-input filter-value-input-1";
  value1Input.type = "text";

  const value2Input = document.createElement("input");
  value2Input.className = "filter-value-input filter-value-input-2";
  value2Input.type = "text";

  const comparePicker = createSearchableAttributePicker({
    className: "filter-compare-picker",
    placeholder: "Select attribute...",
    selected: clause.compareColumn,
    getColumns: () => getComparableColumns(clause.column),
    onSelect: (compareColumn) => {
      updateClauseById(filter.id, clause.id, { compareColumn });
      syncClauseControls(clause, block);
      commitGroup();
    },
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "filter-remove-btn";
  removeBtn.title = filter.clauses.length === 1 ? "Remove filter" : "Remove clause";
  removeBtn.setAttribute("aria-label", removeBtn.title);
  removeBtn.innerHTML = FILTER_DELETE_ICON;
  removeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (filter.clauses.length === 1) {
      removeFilterById(filter.id);
    } else {
      removeClauseById(filter.id, clause.id);
    }
    renderFilterTable();
    applyFiltersAndSort();
    saveSessionState();
  });

  value1Input.addEventListener("input", () => {
    updateClauseById(filter.id, clause.id, { value1: value1Input.value });
    commitGroup();
  });

  value2Input.addEventListener("input", () => {
    updateClauseById(filter.id, clause.id, { value2: value2Input.value });
    commitGroup();
  });

  controls.append(columnPicker, operatorPicker, modePicker, value1Input, value2Input, comparePicker);
  clauseRow.appendChild(controls);

  if (isEditing) {
    const actions = document.createElement("div");
    actions.className = "filter-clause-actions";
    if (isLastClause) {
      actions.appendChild(createFilterJoinToggle(filter, commitGroup));
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "filter-add-clause-btn";
      addBtn.title = "Add filter clause";
      addBtn.setAttribute("aria-label", "Add filter clause");
      addBtn.innerHTML = FILTER_ADD_CLAUSE_ICON;
      addBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const newClause = createEmptyClause({ joinOperator: filter.nextJoinOperator });
        filter.clauses.push(newClause);
        state.editingFilterId = filter.id;
        state.focusClauseId = newClause.id;
        renderFilterTable();
        commitGroup();
      });
      actions.appendChild(addBtn);
    }
    actions.appendChild(removeBtn);
    clauseRow.appendChild(actions);
  }

  block.appendChild(clauseRow);
  syncClauseControls(clause, block);
  syncClauseValidation(block, clause, isEditing);
  return block;
}

function isActiveCellFocus(event) {
  return event.target instanceof Element && Boolean(event.target.closest(".filter-active-cell"));
}

function isRowFormControlFocus(event, row) {
  if (!(event.target instanceof Element)) return false;
  const control = event.target.closest("input, textarea, button, select");
  return Boolean(control && row.contains(control) && !control.closest(".filter-active-cell"));
}

function clearOtherRowEditStates(tbody, rowSelector, currentRow) {
  tbody?.querySelectorAll(`${rowSelector}.is-editing`).forEach((row) => {
    if (row !== currentRow) row.classList.remove("is-editing");
  });
}

function createFilterTableRow(filter, index = 0) {
  const tr = document.createElement("tr");
  tr.className = "filter-table-row";
  tr.classList.toggle("filter-row-even", index % 2 === 1);
  tr.classList.toggle("filter-row-odd", index % 2 === 0);
  tr.classList.toggle("is-draft", !isFilterGroupComplete(filter));
  tr.classList.toggle("is-editing", state.editingFilterId === filter.id);
  tr.dataset.filterId = filter.id;

  const activeTd = document.createElement("td");
  activeTd.className = "filter-active-cell";
  const activeCheckbox = document.createElement("input");
  activeCheckbox.type = "checkbox";
  activeCheckbox.checked = filter.enabled !== false;
  activeCheckbox.title = "Activate filter";
  activeCheckbox.addEventListener("change", () => {
    if (!isFilterGroupComplete(filter)) {
      activeCheckbox.checked = false;
      return;
    }
    updateFilterById(filter.id, { enabled: activeCheckbox.checked });
    applyFiltersAndSort();
    saveSessionState();
  });
  activeTd.appendChild(activeCheckbox);

  const definitionTd = document.createElement("td");
  const groupEl = document.createElement("div");
  groupEl.className = "filter-group";

  const commitGroup = () => {
    const isEditing = state.editingFilterId === filter.id;
    for (const clauseEl of groupEl.querySelectorAll(".filter-clause-block")) {
      const clause = getClauseById(filter, clauseEl.dataset.clauseId);
      if (clause) {
        syncClauseValidation(clauseEl, clause, isEditing);
      }
    }
    syncFilterActivationState(tr, filter, activeCheckbox);
    applyFiltersAndSort();
    saveSessionState();
  };

  syncFilterActivationState(tr, filter, activeCheckbox);

  for (const [clauseIndex, clause] of filter.clauses.entries()) {
    groupEl.appendChild(createClauseBlock(filter, clause, clauseIndex, tr, commitGroup));
  }

  definitionTd.appendChild(groupEl);
  tr.append(activeTd, definitionTd);

  tr.addEventListener("focusin", (event) => {
    if (state.editingFilterId === filter.id) return;
    if (isActiveCellFocus(event)) return;
    state.editingFilterId = filter.id;
    if (isRowFormControlFocus(event, tr)) {
      clearOtherRowEditStates(elements.filterTableBody, "tr.filter-table-row", tr);
      tr.classList.add("is-editing");
      for (const clauseEl of groupEl.querySelectorAll(".filter-clause-block")) {
        const clause = getClauseById(filter, clauseEl.dataset.clauseId);
        if (clause) syncClauseValidation(clauseEl, clause, true);
      }
      syncFilterActivationState(tr, filter, activeCheckbox);
      return;
    }
    renderFilterTable();
  });

  return tr;
}

function detachOrphanedFloatingAttributeLists() {
  for (const list of document.querySelectorAll(".searchable-attribute-list.is-floating")) {
    list.hidden = true;
    list.classList.remove("is-floating");
    if (list.parentElement === document.body) {
      list.remove();
    }
  }
}

function renderFilterTable() {
  if (!elements.filterTableBody) return;
  detachOrphanedFloatingAttributeLists();
  elements.filterTableBody.innerHTML = "";

  if (state.activeFilters.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "filter-empty-row";
    const td = document.createElement("td");
    td.colSpan = 2;
    td.textContent = "No filters yet. Click Add filter to create one.";
    tr.appendChild(td);
    elements.filterTableBody.appendChild(tr);
    return;
  }

  for (const [index, filter] of state.activeFilters.entries()) {
    elements.filterTableBody.appendChild(createFilterTableRow(filter, index));
  }

  const focusFilterId = state.focusFilterId;
  const focusClauseId = state.focusClauseId;
  state.focusFilterId = null;
  state.focusClauseId = null;

  if (focusFilterId) {
    state.editingFilterId = focusFilterId;
    requestAnimationFrame(() => {
      const row = elements.filterTableBody.querySelector(`tr.filter-table-row[data-filter-id="${focusFilterId}"]`);
      row?.classList.add("is-editing");
      const clauseSelector = focusClauseId
        ? `.filter-clause-block[data-clause-id="${focusClauseId}"] .filter-column-picker`
        : ".filter-column-picker";
      row?.querySelector(clauseSelector)?.focusInput?.();
    });
  }
}

function addNewFilterRow() {
  const filter = normalizeFilterRecord({
    id: createFilterId(),
    enabled: false,
    nextJoinOperator: "and",
    joinToggleSelected: false,
    clauses: [createEmptyClause()],
  });
  state.activeFilters.unshift(filter);
  state.focusFilterId = filter.id;
  state.focusClauseId = filter.clauses[0].id;
  state.editingFilterId = filter.id;
  renderFilterTable();
}

function activateAllFilters() {
  for (const filter of state.activeFilters) {
    if (isFilterGroupComplete(filter)) {
      filter.enabled = true;
    }
  }
  renderFilterTable();
  applyFiltersAndSort();
  saveSessionState();
}

function deactivateAllFilters() {
  for (const filter of state.activeFilters) {
    filter.enabled = false;
  }
  renderFilterTable();
  applyFiltersAndSort();
  saveSessionState();
}

function cloneFilters(filters) {
  return normalizeActiveFilters(filters);
}

function attachCalcExpressionAutocomplete(textarea, definition, commitRow) {
  const list = document.createElement("ul");
  list.className = "searchable-attribute-list";
  list.hidden = true;
  document.body.appendChild(list);

  let highlightedIndex = -1;
  let activeTokenStart = -1;
  let activeTokenPartial = "";

  const hideList = () => {
    list.hidden = true;
    highlightedIndex = -1;
    list.classList.remove("is-floating");
    list.style.position = "";
    list.style.left = "";
    list.style.top = "";
    list.style.width = "";
    list.style.maxHeight = "";
    list.style.zIndex = "";
  };

  const getTokenAtCursor = () => {
    const cursor = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, cursor);
    const match = before.match(/\{([^}]*)$/);
    if (!match) return null;
    return {
      start: cursor - match[1].length - 1,
      end: cursor,
      partial: match[1],
    };
  };

  const positionList = () => {
    const rect = textarea.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.left = `${rect.left}px`;
    list.style.width = `${Math.max(rect.width, 220)}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.maxHeight = "224px";
    list.style.zIndex = "110";
    list.classList.add("is-floating");
  };

  const renderMatches = () => {
    const token = getTokenAtCursor();
    if (!token) {
      hideList();
      return;
    }
    activeTokenStart = token.start;
    activeTokenPartial = token.partial;
    const matches = filterAttributeColumns(getCalcReferenceColumns(definition), token.partial);
    list.innerHTML = "";
    highlightedIndex = -1;
    if (matches.length === 0) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "searchable-attribute-empty";
      emptyItem.textContent = "No matches";
      list.appendChild(emptyItem);
    } else {
      for (const column of matches.slice(0, 100)) {
        const item = document.createElement("li");
        item.className = "searchable-attribute-option";
        item.textContent = column;
        item.dataset.value = column;
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          insertColumn(column);
        });
        list.appendChild(item);
      }
    }
    list.hidden = false;
    positionList();
  };

  const insertColumn = (column) => {
    const token = getTokenAtCursor();
    if (!token) return;
    const insertion = `{${column}}`;
    textarea.value = `${textarea.value.slice(0, token.start)}${insertion}${textarea.value.slice(token.end)}`;
    const nextCursor = token.start + insertion.length;
    textarea.focus();
    textarea.setSelectionRange(nextCursor, nextCursor);
    definition.expression = textarea.value;
    hideList();
    commitRow();
  };

  const getListOptions = () => [...list.querySelectorAll(".searchable-attribute-option")];

  const setHighlightedIndex = (nextIndex) => {
    const options = getListOptions();
    if (options.length === 0) {
      highlightedIndex = -1;
      return;
    }
    highlightedIndex = ((nextIndex % options.length) + options.length) % options.length;
    options.forEach((option, index) => {
      option.classList.toggle("is-highlighted", index === highlightedIndex);
    });
    options[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  };

  textarea.addEventListener("input", () => {
    definition.expression = textarea.value;
    renderMatches();
    commitRow();
  });

  textarea.addEventListener("blur", () => {
    window.setTimeout(hideList, 120);
  });

  textarea.addEventListener("keydown", (event) => {
    const options = getListOptions();
    const listIsOpen = !list.hidden && options.length > 0;

    if (event.key === "Tab" && listIsOpen) {
      event.preventDefault();
      if (event.shiftKey) {
        setHighlightedIndex(highlightedIndex <= 0 ? options.length - 1 : highlightedIndex - 1);
      } else {
        setHighlightedIndex(highlightedIndex < 0 ? 0 : highlightedIndex + 1);
      }
      return;
    }

    if (event.key === "ArrowDown" && listIsOpen) {
      event.preventDefault();
      setHighlightedIndex(highlightedIndex < 0 ? 0 : highlightedIndex + 1);
      return;
    }

    if (event.key === "ArrowUp" && listIsOpen) {
      event.preventDefault();
      setHighlightedIndex(highlightedIndex < 0 ? options.length - 1 : highlightedIndex - 1);
      return;
    }

    if (event.key === "Enter" && listIsOpen) {
      event.preventDefault();
      if (highlightedIndex >= 0 && options[highlightedIndex]) {
        insertColumn(options[highlightedIndex].dataset.value);
      } else if (options.length === 1) {
        insertColumn(options[0].dataset.value);
      }
      return;
    }

    if (event.key === "Escape" && listIsOpen) {
      event.preventDefault();
      hideList();
    }
  });

  textarea.addEventListener("focus", renderMatches);

  return () => {
    hideList();
    list.remove();
  };
}

function syncCalcRowValidation(tr, definition, nameInput, expressionInput, errorEl, isEditing) {
  const { valid, errors } = validateCalcDefinition(definition);
  const showHint = !valid && (isEditing || definition.name || definition.expression);

  tr.classList.toggle("is-draft", !valid);
  nameInput.classList.toggle("is-invalid", showHint && errors.some((error) => error.startsWith("Enter a name") || error.startsWith("Name")));
  expressionInput.classList.toggle("is-invalid", showHint && errors.some((error) => !error.startsWith("Enter a name") && !error.startsWith("Name")));
  errorEl.hidden = !showHint;
  errorEl.textContent = showHint ? errors.join(" · ") : "";
}

function syncCalcActivationState(tr, definition, activeCheckbox) {
  const canActivate = isCalcDefinitionComplete(definition);
  if (!canActivate && definition.enabled !== false) {
    definition.enabled = false;
  }
  tr.classList.toggle("is-draft", !canActivate);
  activeCheckbox.disabled = !canActivate;
  activeCheckbox.checked = definition.enabled !== false;
  activeCheckbox.title = canActivate ? "Activate calculated attribute" : "Complete name and formula to activate";
}

function createCalcTableRow(definition, index = 0) {
  const tr = document.createElement("tr");
  tr.className = "calc-table-row filter-table-row";
  tr.classList.toggle("filter-row-even", index % 2 === 1);
  tr.classList.toggle("filter-row-odd", index % 2 === 0);
  tr.classList.toggle("is-editing", state.editingCalcId === definition.id);
  tr.dataset.calcId = definition.id;

  const activeTd = document.createElement("td");
  activeTd.className = "filter-active-cell";
  const activeCheckbox = document.createElement("input");
  activeCheckbox.type = "checkbox";
  activeCheckbox.checked = definition.enabled !== false;
  activeCheckbox.addEventListener("change", () => {
    if (!isCalcDefinitionComplete(definition)) {
      activeCheckbox.checked = false;
      return;
    }
    definition.enabled = activeCheckbox.checked;
    applyCalculatedColumnsUpdate();
    if (definition.enabled && definition.name && !state.visibleColumns.includes(definition.name)) {
      setVisibleColumns(insertCalcColumnsIntoVisibleColumns(state.visibleColumns, [definition.name]));
    }
  });
  activeTd.appendChild(activeCheckbox);

  const nameTd = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "calc-name-input";
  nameInput.placeholder = "Attribute name";
  nameInput.value = definition.name;
  nameTd.appendChild(nameInput);

  const expressionTd = document.createElement("td");
  const editor = document.createElement("div");
  editor.className = "calc-expression-editor";
  const expressionInput = document.createElement("textarea");
  expressionInput.className = "calc-expression-input";
  expressionInput.placeholder = "Formula e.g. {damage.max} - {damage.min} or {penetration.near} > 0";
  expressionInput.value = definition.expression;
  expressionInput.rows = 2;
  const errorEl = document.createElement("div");
  errorEl.className = "calc-expression-error";
  errorEl.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "calc-row-actions";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "filter-remove-btn";
  removeBtn.title = "Remove calculated attribute";
  removeBtn.setAttribute("aria-label", removeBtn.title);
  removeBtn.innerHTML = FILTER_DELETE_ICON;
  actions.appendChild(removeBtn);
  editor.append(expressionInput, errorEl, actions);
  expressionTd.appendChild(editor);

  const commitRow = ({ refreshTable = false } = {}) => {
    const isEditing = state.editingCalcId === definition.id;
    syncCalcRowValidation(tr, definition, nameInput, expressionInput, errorEl, isEditing);
    syncCalcActivationState(tr, definition, activeCheckbox);
    recomputeCalculatedColumns();
    rebuildCalculatedRegistry();
    buildAvailableColumns();
    renderColumnChooser();
    state.visibleColumns = ensureRequiredVisibleColumns(
      state.visibleColumns.filter((column) => state.availableColumns.includes(column)),
    );
    applyFiltersAndSort();
    saveSessionState();
    if (refreshTable) renderCalcTable();
  };

  nameInput.addEventListener("input", () => {
    definition.name = nameInput.value;
    commitRow();
  });

  removeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    removeCalculatedColumnById(definition.id);
  });

  attachCalcExpressionAutocomplete(expressionInput, definition, commitRow);
  syncCalcRowValidation(tr, definition, nameInput, expressionInput, errorEl, state.editingCalcId === definition.id);
  syncCalcActivationState(tr, definition, activeCheckbox);

  tr.addEventListener("focusin", (event) => {
    if (state.editingCalcId === definition.id) return;
    if (isActiveCellFocus(event)) return;
    state.editingCalcId = definition.id;
    if (isRowFormControlFocus(event, tr)) {
      clearOtherRowEditStates(elements.calcTableBody, "tr.calc-table-row", tr);
      tr.classList.add("is-editing");
      syncCalcRowValidation(tr, definition, nameInput, expressionInput, errorEl, true);
      syncCalcActivationState(tr, definition, activeCheckbox);
      return;
    }
    renderCalcTable();
  });

  tr.append(activeTd, nameTd, expressionTd);
  return tr;
}

function renderCalcTable() {
  if (!elements.calcTableBody) return;
  detachOrphanedFloatingAttributeLists();
  elements.calcTableBody.innerHTML = "";

  if (state.calculatedColumns.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "filter-empty-row";
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = "No calculated attributes yet. Click Add calculated attribute to create one.";
    tr.appendChild(td);
    elements.calcTableBody.appendChild(tr);
    return;
  }

  for (const [index, definition] of state.calculatedColumns.entries()) {
    elements.calcTableBody.appendChild(createCalcTableRow(definition, index));
  }

  const focusCalcId = state.focusCalcId;
  state.focusCalcId = null;
  if (focusCalcId) {
    state.editingCalcId = focusCalcId;
    requestAnimationFrame(() => {
      const row = elements.calcTableBody.querySelector(`tr.calc-table-row[data-calc-id="${focusCalcId}"]`);
      row?.classList.add("is-editing");
      row?.querySelector(".calc-name-input")?.focus();
    });
  }
}

function addNewCalcRow() {
  const definition = normalizeCalculatedColumnRecord({
    id: createCalcId(),
    name: "",
    expression: "",
    enabled: false,
  });
  state.calculatedColumns.unshift(definition);
  state.editingCalcId = definition.id;
  state.focusCalcId = definition.id;
  renderCalcTable();
}

function displayAllCalculatedColumns() {
  for (const definition of state.calculatedColumns) {
    if (isCalcDefinitionComplete(definition)) {
      definition.enabled = true;
    }
  }
  const names = getActiveCalculatedColumns().map((definition) => definition.name);
  setVisibleColumns(insertCalcColumnsIntoVisibleColumns(state.visibleColumns, names));
  applyCalculatedColumnsUpdate();
}

function clearAllCalculatedColumns() {
  if (state.calculatedColumns.length === 0) return;
  if (!window.confirm("Remove all calculated attributes?")) return;
  const calcNames = new Set(state.calculatedColumns.map((definition) => definition.name));
  state.calculatedColumns = [];
  state.editingCalcId = null;
  state.focusCalcId = null;
  state.visibleColumns = state.visibleColumns.filter((column) => !calcNames.has(column));
  applyCalculatedColumnsUpdate();
  setVisibleColumns(state.visibleColumns.length ? state.visibleColumns : CORE_COLUMNS);
}

function renderCalculatedColumns() {
  renderCalcTable();
}

function addCalculatedColumn() {
  addNewCalcRow();
}

function snapshotCurrentState() {
  return {
    visibleColumns: [...state.visibleColumns],
    activeFilters: cloneFilters(state.activeFilters),
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
    rowsPerPage: state.rowsPerPage,
    search: elements.searchInput.value,
    faction: elements.factionFilter.value,
    category: elements.categoryFilter.value,
    calculatedColumns: cloneCalculatedColumns(state.calculatedColumns),
    collapsedColumnGroups: [...state.collapsedColumnGroups],
    collapsedColumnOrderGroups: [...state.collapsedColumnOrderGroups],
    activePresetName: state.activePresetName,
    activeFilterPresetName: state.activeFilterPresetName,
    activeCalcPresetName: state.activeCalcPresetName,
    pinnedRowKeys: [...state.pinnedRowKeys],
    activeVersionTag: state.activeVersionTag,
  };
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const savedVisibleColumns = Array.isArray(snapshot.visibleColumns) ? snapshot.visibleColumns : CORE_COLUMNS;

  state.activeFilters = normalizeActiveFilters(snapshot.activeFilters);
  state.calculatedColumns = normalizeCalculatedColumns(snapshot.calculatedColumns);
  state.collapsedColumnGroups = new Set(
    Array.isArray(snapshot.collapsedColumnGroups) ? snapshot.collapsedColumnGroups : [],
  );
  state.collapsedColumnOrderGroups = new Set(
    Array.isArray(snapshot.collapsedColumnOrderGroups) ? snapshot.collapsedColumnOrderGroups : [],
  );
  state.activePresetName =
    typeof snapshot.activePresetName === "string" && snapshot.activePresetName
      ? snapshot.activePresetName
      : DEFAULT_PRESET_NAME;
  state.activeFilterPresetName =
    typeof snapshot.activeFilterPresetName === "string" && snapshot.activeFilterPresetName
      ? snapshot.activeFilterPresetName
      : DEFAULT_FILTER_PRESET_NAME;
  state.activeCalcPresetName =
    typeof snapshot.activeCalcPresetName === "string" && snapshot.activeCalcPresetName
      ? snapshot.activeCalcPresetName
      : DEFAULT_CALC_PRESET_NAME;
  state.pinnedRowKeys = Array.isArray(snapshot.pinnedRowKeys)
    ? snapshot.pinnedRowKeys.filter((key) => typeof key === "string" && findRowByKey(key))
    : [];
  if (typeof snapshot.activeVersionTag === "string" && snapshot.activeVersionTag) {
    state.activeVersionTag = snapshot.activeVersionTag;
  }
  normalizeLegacyCalculatedDefinitions();

  if (
    state.calculatedColumns.length === 0 &&
    !isDefaultCalcPreset(state.activeCalcPresetName) &&
    hasStoredCalcPreset(state.activeCalcPresetName)
  ) {
    const calcSnapshot = normalizeCalcPresetSnapshot(
      state.calcPresets[state.activeCalcPresetName],
      state.activeCalcPresetName,
    );
    if (calcSnapshot?.calculatedColumns?.length) {
      state.calculatedColumns = cloneCalculatedColumns(calcSnapshot.calculatedColumns);
    }
  }

  recomputeCalculatedColumns();
  rebuildCalculatedRegistry();
  buildAvailableColumns();
  computeScalarColumnDisplayWidths();

  state.visibleColumns = ensureRequiredVisibleColumns(
    savedVisibleColumns.filter((column) => state.availableColumns.includes(column)),
  );
  if (state.visibleColumns.length === 0) {
    state.visibleColumns = ["weaponName", "faction", "category"];
  }

  state.sortKey = state.visibleColumns.includes(snapshot.sortKey) ? snapshot.sortKey : state.visibleColumns[0];
  state.sortDirection = snapshot.sortDirection === "desc" ? "desc" : "asc";
  state.rowsPerPage = Number(snapshot.rowsPerPage) || 50;

  elements.rowsPerPage.value = String(state.rowsPerPage);
  elements.searchInput.value = snapshot.search || "";
  elements.factionFilter.value = snapshot.faction || "";
  elements.categoryFilter.value = snapshot.category || "";

  renderColumnChooser();
  renderFilterTable();
  renderCalculatedColumns();
  applyFiltersAndSort();
}

function saveSessionState() {
  try {
    localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(snapshotCurrentState()));
  } catch (error) {
    console.warn("Session save failed", error);
  }
}

function loadSessionState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Session load failed", error);
    return null;
  }
}

function savePresets() {
  try {
    localStorage.setItem(STORAGE_KEYS.presets, JSON.stringify(state.presets));
  } catch (error) {
    console.warn("Presets save failed", error);
    throw error;
  }
}

function loadPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.presets);
    state.presets = raw ? JSON.parse(raw) : {};
  } catch (error) {
    state.presets = {};
  }
  if (state.presets[DEFAULT_PRESET_NAME]) {
    delete state.presets[DEFAULT_PRESET_NAME];
  }
  normalizeStoredPresets();
}

function isDefaultPreset(name) {
  return name === DEFAULT_PRESET_NAME;
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function normalizePresetSnapshot(value, presetName) {
  if (Array.isArray(value)) {
    return {
      visibleColumns: value,
      activeFilters: [],
      calculatedColumns: [],
      collapsedColumnGroups: [],
      sortKey: value[0] || "weaponName",
      sortDirection: "asc",
      rowsPerPage: 50,
      search: "",
      faction: "",
      category: "",
      activePresetName: presetName,
    };
  }
  if (!value || typeof value !== "object") return null;
  const visibleColumns = Array.isArray(value.visibleColumns) ? value.visibleColumns : CORE_COLUMNS;
  return {
    visibleColumns,
    activeFilters: Array.isArray(value.activeFilters) ? value.activeFilters : [],
    calculatedColumns: Array.isArray(value.calculatedColumns) ? value.calculatedColumns : [],
    collapsedColumnGroups: Array.isArray(value.collapsedColumnGroups) ? value.collapsedColumnGroups : [],
    sortKey: typeof value.sortKey === "string" ? value.sortKey : visibleColumns[0] || "weaponName",
    sortDirection: value.sortDirection === "desc" ? "desc" : "asc",
    rowsPerPage: Number(value.rowsPerPage) || 50,
    search: typeof value.search === "string" ? value.search : "",
    faction: typeof value.faction === "string" ? value.faction : "",
    category: typeof value.category === "string" ? value.category : "",
    activePresetName: presetName,
  };
}

function normalizeStoredPresets() {
  const normalized = {};
  for (const [name, value] of Object.entries(state.presets)) {
    if (isDefaultPreset(name)) continue;
    const snapshot = normalizePresetSnapshot(value, name);
    if (snapshot) normalized[name] = snapshot;
  }
  state.presets = normalized;
}

function hasStoredPreset(name) {
  return Boolean(name) && !isDefaultPreset(name) && Object.prototype.hasOwnProperty.call(state.presets, name);
}

function getSelectedPresetName() {
  const selectValue = elements.presetSelect?.value?.trim();
  if (selectValue) {
    state.activePresetName = selectValue;
    return selectValue;
  }
  return state.activePresetName || DEFAULT_PRESET_NAME;
}

function syncPresetSelectValue(name) {
  if (!elements.presetSelect) return;
  suppressPresetSelectChange = true;
  if (!isDefaultPreset(name) && hasStoredPreset(name)) {
    const exists = [...elements.presetSelect.options].some((option) => option.value === name);
    if (!exists) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      elements.presetSelect.appendChild(option);
    }
  }
  if ([...elements.presetSelect.options].some((option) => option.value === name)) {
    elements.presetSelect.value = name;
  }
  state.activePresetName = name;
  suppressPresetSelectChange = false;
}

function showPresetSavedMessage(name) {
  if (!elements.statusText) return;
  elements.statusText.textContent = `Saved preset "${name}"`;
}

function applyDefaultPreset() {
  state.activePresetName = DEFAULT_PRESET_NAME;
  setVisibleColumns(CORE_COLUMNS);
}

function loadPresetByName(name) {
  if (!name) return;
  state.activePresetName = name;
  if (isDefaultPreset(name)) {
    applyDefaultPreset();
    renderPresetOptions(name);
    return;
  }
  const snapshot = normalizePresetSnapshot(state.presets[name], name);
  if (!snapshot) return;
  state.presets[name] = snapshot;
  applySnapshot(snapshot);
  state.activePresetName = name;
  renderPresetOptions(name);
}

function renderPresetOptions(selectedName = state.activePresetName || DEFAULT_PRESET_NAME) {
  if (!elements.presetSelect) return;

  suppressPresetSelectChange = true;
  elements.presetSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = DEFAULT_PRESET_NAME;
  defaultOption.textContent = DEFAULT_PRESET_NAME;
  elements.presetSelect.appendChild(defaultOption);

  for (const name of Object.keys(state.presets).sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.presetSelect.appendChild(option);
  }

  const canSelect =
    selectedName === DEFAULT_PRESET_NAME || hasStoredPreset(selectedName);
  const nextValue = canSelect ? selectedName : DEFAULT_PRESET_NAME;
  elements.presetSelect.value = nextValue;
  state.activePresetName = nextValue;
  suppressPresetSelectChange = false;
}

function saveNamedPreset() {
  try {
    const selected = getSelectedPresetName();
    const snapshot = cloneSnapshot(snapshotCurrentState());

    if (isDefaultPreset(selected)) {
      const entered = window.prompt("Preset name:");
      const name = entered ? entered.trim() : "";
      if (!name || isDefaultPreset(name)) return;
      if (hasStoredPreset(name) && !window.confirm(`Overwrite preset "${name}"?`)) return;
      state.presets[name] = snapshot;
      state.activePresetName = name;
      savePresets();
      saveSessionState();
      renderPresetOptions(name);
      showPresetSavedMessage(name);
      renderPresetManageTable();
      return;
    }

    state.presets[selected] = snapshot;
    state.activePresetName = selected;
    savePresets();
    saveSessionState();
    syncPresetSelectValue(selected);
    showPresetSavedMessage(selected);
    renderPresetManageTable();
  } catch (error) {
    console.error("Save preset failed:", error);
    window.alert(`Failed to save preset: ${error.message}`);
  }
}

function renamePreset(oldName, newName) {
  if (isDefaultPreset(oldName) || isDefaultPreset(newName)) return false;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return false;
  if (state.presets[trimmed]) return false;
  state.presets[trimmed] = state.presets[oldName];
  delete state.presets[oldName];
  savePresets();
  if (elements.presetSelect.value === oldName) {
    elements.presetSelect.value = trimmed;
  }
  renderPresetOptions(elements.presetSelect.value);
  renderPresetManageTable();
  return true;
}

function deletePresetByName(name) {
  if (isDefaultPreset(name) || !state.presets[name]) return;
  delete state.presets[name];
  savePresets();
  if (elements.presetSelect.value === name) {
    state.activePresetName = DEFAULT_PRESET_NAME;
    applyDefaultPreset();
    renderPresetOptions(DEFAULT_PRESET_NAME);
  } else {
    renderPresetOptions(elements.presetSelect.value);
  }
  renderPresetManageTable();
}

function startPresetNameEdit(nameCell, presetName) {
  if (isDefaultPreset(presetName)) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "preset-name-edit-input";
  input.value = presetName;
  nameCell.textContent = "";
  nameCell.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const nextName = input.value.trim();
    if (nextName && nextName !== presetName) {
      if (!renamePreset(presetName, nextName)) {
        window.alert("Could not rename preset. Name may already exist or is invalid.");
      }
    }
    renderPresetManageTable();
  };

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      renderPresetManageTable();
    }
  });
}

function renderPresetManageTable() {
  if (!elements.presetManageTableBody) return;
  elements.presetManageTableBody.innerHTML = "";

  const defaultRow = document.createElement("tr");
  defaultRow.className = "preset-manage-row is-default";
  const defaultNameCell = document.createElement("td");
  defaultNameCell.textContent = DEFAULT_PRESET_NAME;
  const defaultActionCell = document.createElement("td");
  defaultActionCell.textContent = "—";
  defaultActionCell.className = "preset-manage-actions-muted";
  defaultRow.appendChild(defaultNameCell);
  defaultRow.appendChild(defaultActionCell);
  elements.presetManageTableBody.appendChild(defaultRow);

  for (const name of Object.keys(state.presets).sort()) {
    const row = document.createElement("tr");
    row.className = "preset-manage-row";

    const nameCell = document.createElement("td");
    nameCell.className = "preset-manage-name";
    nameCell.textContent = name;
    nameCell.title = "Click to rename";
    nameCell.addEventListener("click", () => startPresetNameEdit(nameCell, name));

    const actionCell = document.createElement("td");
    actionCell.className = "preset-manage-actions";
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`Delete preset "${name}"?`)) {
        deletePresetByName(name);
      }
    });
    actionCell.appendChild(deleteBtn);

    row.appendChild(nameCell);
    row.appendChild(actionCell);
    elements.presetManageTableBody.appendChild(row);
  }
}

function openManagePresetsDialog() {
  if (!elements.managePresetsDialog) return;
  renderPresetManageTable();
  elements.managePresetsDialog.showModal();
}

function closeManagePresetsDialog() {
  elements.managePresetsDialog?.close();
}

function isDefaultFilterPreset(name) {
  return name === DEFAULT_FILTER_PRESET_NAME;
}

function normalizeFilterPresetSnapshot(value, presetName) {
  if (Array.isArray(value)) {
    return {
      activeFilters: normalizeActiveFilters(value),
      activeFilterPresetName: presetName,
    };
  }
  if (!value || typeof value !== "object") return null;
  const filters = value.activeFilters ?? value.filters;
  return {
    activeFilters: normalizeActiveFilters(Array.isArray(filters) ? filters : []),
    activeFilterPresetName: presetName,
  };
}

function loadFilterPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.filterPresets);
    state.filterPresets = raw ? JSON.parse(raw) : {};
  } catch (error) {
    state.filterPresets = {};
  }
  if (state.filterPresets[DEFAULT_FILTER_PRESET_NAME]) {
    delete state.filterPresets[DEFAULT_FILTER_PRESET_NAME];
  }
  const normalized = {};
  for (const [name, value] of Object.entries(state.filterPresets)) {
    if (isDefaultFilterPreset(name)) continue;
    const snapshot = normalizeFilterPresetSnapshot(value, name);
    if (snapshot) normalized[name] = snapshot;
  }
  state.filterPresets = normalized;
}

function saveFilterPresets() {
  try {
    localStorage.setItem(STORAGE_KEYS.filterPresets, JSON.stringify(state.filterPresets));
  } catch (error) {
    console.warn("Filter presets save failed", error);
    throw error;
  }
}

function hasStoredFilterPreset(name) {
  return Boolean(name) && !isDefaultFilterPreset(name) && Object.prototype.hasOwnProperty.call(state.filterPresets, name);
}

function getSelectedFilterPresetName() {
  const selectValue = elements.filterPresetSelect?.value?.trim();
  if (selectValue) {
    state.activeFilterPresetName = selectValue;
    return selectValue;
  }
  return state.activeFilterPresetName || DEFAULT_FILTER_PRESET_NAME;
}

function syncFilterPresetSelectValue(name) {
  if (!elements.filterPresetSelect) return;
  suppressFilterPresetSelectChange = true;
  if (!isDefaultFilterPreset(name) && hasStoredFilterPreset(name)) {
    const exists = [...elements.filterPresetSelect.options].some((option) => option.value === name);
    if (!exists) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      elements.filterPresetSelect.appendChild(option);
    }
  }
  if ([...elements.filterPresetSelect.options].some((option) => option.value === name)) {
    elements.filterPresetSelect.value = name;
  }
  state.activeFilterPresetName = name;
  suppressFilterPresetSelectChange = false;
}

function renderFilterPresetOptions(selectedName = state.activeFilterPresetName || DEFAULT_FILTER_PRESET_NAME) {
  if (!elements.filterPresetSelect) return;

  suppressFilterPresetSelectChange = true;
  elements.filterPresetSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = DEFAULT_FILTER_PRESET_NAME;
  defaultOption.textContent = DEFAULT_FILTER_PRESET_NAME;
  elements.filterPresetSelect.appendChild(defaultOption);

  for (const name of Object.keys(state.filterPresets).sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.filterPresetSelect.appendChild(option);
  }

  const canSelect = selectedName === DEFAULT_FILTER_PRESET_NAME || hasStoredFilterPreset(selectedName);
  const nextValue = canSelect ? selectedName : DEFAULT_FILTER_PRESET_NAME;
  elements.filterPresetSelect.value = nextValue;
  state.activeFilterPresetName = nextValue;
  suppressFilterPresetSelectChange = false;
}

function applyDefaultFilterPreset() {
  state.activeFilterPresetName = DEFAULT_FILTER_PRESET_NAME;
  state.activeFilters = [];
  renderFilterTable();
  applyFiltersAndSort();
}

function loadFilterPresetByName(name) {
  if (!name) return;
  state.activeFilterPresetName = name;
  if (isDefaultFilterPreset(name)) {
    applyDefaultFilterPreset();
    renderFilterPresetOptions(name);
    saveSessionState();
    return;
  }
  const snapshot = normalizeFilterPresetSnapshot(state.filterPresets[name], name);
  if (!snapshot) return;
  state.filterPresets[name] = snapshot;
  state.activeFilters = cloneFilters(snapshot.activeFilters);
  renderFilterTable();
  applyFiltersAndSort();
  state.activeFilterPresetName = name;
  renderFilterPresetOptions(name);
  saveSessionState();
}

function saveNamedFilterPreset() {
  try {
    const selected = getSelectedFilterPresetName();
    const snapshot = {
      activeFilters: cloneFilters(state.activeFilters),
      activeFilterPresetName: selected,
    };

    if (isDefaultFilterPreset(selected)) {
      const entered = window.prompt("Filter preset name:");
      const name = entered ? entered.trim() : "";
      if (!name || isDefaultFilterPreset(name)) return;
      if (hasStoredFilterPreset(name) && !window.confirm(`Overwrite filter preset "${name}"?`)) return;
      snapshot.activeFilterPresetName = name;
      state.filterPresets[name] = snapshot;
      state.activeFilterPresetName = name;
      saveFilterPresets();
      saveSessionState();
      renderFilterPresetOptions(name);
      renderFilterPresetManageTable();
      return;
    }

    snapshot.activeFilterPresetName = selected;
    state.filterPresets[selected] = snapshot;
    state.activeFilterPresetName = selected;
    saveFilterPresets();
    saveSessionState();
    syncFilterPresetSelectValue(selected);
    renderFilterPresetManageTable();
  } catch (error) {
    console.error("Save filter preset failed:", error);
    window.alert(`Failed to save filter preset: ${error.message}`);
  }
}

function renameFilterPreset(oldName, newName) {
  if (isDefaultFilterPreset(oldName) || isDefaultFilterPreset(newName)) return false;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return false;
  if (state.filterPresets[trimmed]) return false;
  state.filterPresets[trimmed] = state.filterPresets[oldName];
  delete state.filterPresets[oldName];
  saveFilterPresets();
  if (elements.filterPresetSelect?.value === oldName) {
    elements.filterPresetSelect.value = trimmed;
  }
  renderFilterPresetOptions(elements.filterPresetSelect?.value || DEFAULT_FILTER_PRESET_NAME);
  renderFilterPresetManageTable();
  return true;
}

function deleteFilterPresetByName(name) {
  if (isDefaultFilterPreset(name) || !state.filterPresets[name]) return;
  delete state.filterPresets[name];
  saveFilterPresets();
  if (elements.filterPresetSelect?.value === name) {
    state.activeFilterPresetName = DEFAULT_FILTER_PRESET_NAME;
    applyDefaultFilterPreset();
    renderFilterPresetOptions(DEFAULT_FILTER_PRESET_NAME);
  } else {
    renderFilterPresetOptions(elements.filterPresetSelect?.value || DEFAULT_FILTER_PRESET_NAME);
  }
  renderFilterPresetManageTable();
}

function startFilterPresetNameEdit(nameCell, presetName) {
  if (isDefaultFilterPreset(presetName)) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "preset-name-edit-input";
  input.value = presetName;
  nameCell.textContent = "";
  nameCell.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const nextName = input.value.trim();
    if (nextName && nextName !== presetName) {
      if (!renameFilterPreset(presetName, nextName)) {
        window.alert("Could not rename filter preset. Name may already exist or is invalid.");
      }
    }
    renderFilterPresetManageTable();
  };

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      renderFilterPresetManageTable();
    }
  });
}

function renderFilterPresetManageTable() {
  if (!elements.filterPresetManageTableBody) return;
  elements.filterPresetManageTableBody.innerHTML = "";

  const defaultRow = document.createElement("tr");
  const defaultNameCell = document.createElement("td");
  defaultNameCell.textContent = DEFAULT_FILTER_PRESET_NAME;
  const defaultActionCell = document.createElement("td");
  defaultActionCell.textContent = "—";
  defaultRow.append(defaultNameCell, defaultActionCell);
  elements.filterPresetManageTableBody.appendChild(defaultRow);

  for (const name of Object.keys(state.filterPresets).sort()) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = name;
    nameCell.title = "Click to rename";
    nameCell.style.cursor = "pointer";
    nameCell.addEventListener("click", () => startFilterPresetNameEdit(nameCell, name));

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`Delete filter preset "${name}"?`)) {
        deleteFilterPresetByName(name);
      }
    });
    actionCell.appendChild(deleteBtn);
    row.append(nameCell, actionCell);
    elements.filterPresetManageTableBody.appendChild(row);
  }
}

function openManageFilterPresetsDialog() {
  if (!elements.manageFilterPresetsDialog) return;
  renderFilterPresetManageTable();
  elements.manageFilterPresetsDialog.showModal();
}

function closeManageFilterPresetsDialog() {
  elements.manageFilterPresetsDialog?.close();
}

function isDefaultCalcPreset(name) {
  return name === DEFAULT_CALC_PRESET_NAME;
}

function normalizeCalcPresetSnapshot(value, presetName) {
  if (Array.isArray(value)) {
    return {
      calculatedColumns: normalizeCalculatedColumns(value),
      activeCalcPresetName: presetName,
    };
  }
  if (!value || typeof value !== "object") return null;
  const columns = value.calculatedColumns ?? value.columns;
  return {
    calculatedColumns: normalizeCalculatedColumns(Array.isArray(columns) ? columns : []),
    activeCalcPresetName: presetName,
  };
}

function loadCalcPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.calcPresets);
    state.calcPresets = raw ? JSON.parse(raw) : {};
  } catch (error) {
    state.calcPresets = {};
  }
  if (state.calcPresets[DEFAULT_CALC_PRESET_NAME]) {
    delete state.calcPresets[DEFAULT_CALC_PRESET_NAME];
  }
  const normalized = {};
  for (const [name, value] of Object.entries(state.calcPresets)) {
    if (isDefaultCalcPreset(name)) continue;
    const snapshot = normalizeCalcPresetSnapshot(value, name);
    if (snapshot) normalized[name] = snapshot;
  }
  state.calcPresets = normalized;
}

function saveCalcPresets() {
  try {
    localStorage.setItem(STORAGE_KEYS.calcPresets, JSON.stringify(state.calcPresets));
  } catch (error) {
    console.warn("Calculated attribute presets save failed", error);
    throw error;
  }
}

function hasStoredCalcPreset(name) {
  return Boolean(name) && !isDefaultCalcPreset(name) && Object.prototype.hasOwnProperty.call(state.calcPresets, name);
}

function getSelectedCalcPresetName() {
  const selectValue = elements.calcPresetSelect?.value?.trim();
  if (selectValue) {
    state.activeCalcPresetName = selectValue;
    return selectValue;
  }
  return state.activeCalcPresetName || DEFAULT_CALC_PRESET_NAME;
}

function renderCalcPresetOptions(selectedName = state.activeCalcPresetName || DEFAULT_CALC_PRESET_NAME) {
  if (!elements.calcPresetSelect) return;

  suppressCalcPresetSelectChange = true;
  elements.calcPresetSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = DEFAULT_CALC_PRESET_NAME;
  defaultOption.textContent = DEFAULT_CALC_PRESET_NAME;
  elements.calcPresetSelect.appendChild(defaultOption);

  for (const name of Object.keys(state.calcPresets).sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.calcPresetSelect.appendChild(option);
  }

  const canSelect = selectedName === DEFAULT_CALC_PRESET_NAME || hasStoredCalcPreset(selectedName);
  const nextValue = canSelect ? selectedName : DEFAULT_CALC_PRESET_NAME;
  elements.calcPresetSelect.value = nextValue;
  state.activeCalcPresetName = nextValue;
  suppressCalcPresetSelectChange = false;
}

function applyDefaultCalcPreset() {
  state.activeCalcPresetName = DEFAULT_CALC_PRESET_NAME;
  state.calculatedColumns = [];
  state.editingCalcId = null;
  state.focusCalcId = null;
  applyCalculatedColumnsUpdate();
}

function loadCalcPresetByName(name) {
  if (!name) return;
  state.activeCalcPresetName = name;
  if (isDefaultCalcPreset(name)) {
    applyDefaultCalcPreset();
    renderCalcPresetOptions(name);
    saveSessionState();
    return;
  }
  const snapshot = normalizeCalcPresetSnapshot(state.calcPresets[name], name);
  if (!snapshot) return;
  state.calcPresets[name] = snapshot;
  state.calculatedColumns = cloneCalculatedColumns(snapshot.calculatedColumns);
  state.editingCalcId = null;
  state.focusCalcId = null;
  applyCalculatedColumnsUpdate();
  state.activeCalcPresetName = name;
  renderCalcPresetOptions(name);
  saveSessionState();
}

function saveNamedCalcPreset() {
  try {
    const selected = getSelectedCalcPresetName();
    const snapshot = {
      calculatedColumns: cloneCalculatedColumns(state.calculatedColumns),
      activeCalcPresetName: selected,
    };

    if (isDefaultCalcPreset(selected)) {
      const entered = window.prompt("Calculated attribute preset name:");
      const name = entered ? entered.trim() : "";
      if (!name || isDefaultCalcPreset(name)) return;
      if (hasStoredCalcPreset(name) && !window.confirm(`Overwrite calculated attribute preset "${name}"?`)) return;
      snapshot.activeCalcPresetName = name;
      state.calcPresets[name] = snapshot;
      state.activeCalcPresetName = name;
      saveCalcPresets();
      saveSessionState();
      renderCalcPresetOptions(name);
      renderCalcPresetManageTable();
      return;
    }

    snapshot.activeCalcPresetName = selected;
    state.calcPresets[selected] = snapshot;
    state.activeCalcPresetName = selected;
    saveCalcPresets();
    saveSessionState();
    renderCalcPresetOptions(selected);
    renderCalcPresetManageTable();
  } catch (error) {
    console.error("Save calculated attribute preset failed:", error);
    window.alert(`Failed to save calculated attribute preset: ${error.message}`);
  }
}

function renameCalcPreset(oldName, newName) {
  if (isDefaultCalcPreset(oldName) || isDefaultCalcPreset(newName)) return false;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return false;
  if (state.calcPresets[trimmed]) return false;
  state.calcPresets[trimmed] = state.calcPresets[oldName];
  delete state.calcPresets[oldName];
  saveCalcPresets();
  if (elements.calcPresetSelect?.value === oldName) {
    elements.calcPresetSelect.value = trimmed;
  }
  renderCalcPresetOptions(elements.calcPresetSelect?.value || DEFAULT_CALC_PRESET_NAME);
  renderCalcPresetManageTable();
  return true;
}

function deleteCalcPresetByName(name) {
  if (isDefaultCalcPreset(name) || !state.calcPresets[name]) return;
  delete state.calcPresets[name];
  saveCalcPresets();
  if (elements.calcPresetSelect?.value === name) {
    state.activeCalcPresetName = DEFAULT_CALC_PRESET_NAME;
    applyDefaultCalcPreset();
    renderCalcPresetOptions(DEFAULT_CALC_PRESET_NAME);
  } else {
    renderCalcPresetOptions(elements.calcPresetSelect?.value || DEFAULT_CALC_PRESET_NAME);
  }
  renderCalcPresetManageTable();
}

function startCalcPresetNameEdit(nameCell, presetName) {
  if (isDefaultCalcPreset(presetName)) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "preset-name-edit-input";
  input.value = presetName;
  nameCell.textContent = "";
  nameCell.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const nextName = input.value.trim();
    if (nextName && nextName !== presetName) {
      if (!renameCalcPreset(presetName, nextName)) {
        window.alert("Could not rename preset. Name may already exist or is invalid.");
      }
    }
    renderCalcPresetManageTable();
  };

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      renderCalcPresetManageTable();
    }
  });
}

function renderCalcPresetManageTable() {
  if (!elements.calcPresetManageTableBody) return;
  elements.calcPresetManageTableBody.innerHTML = "";

  const defaultRow = document.createElement("tr");
  const defaultNameCell = document.createElement("td");
  defaultNameCell.textContent = DEFAULT_CALC_PRESET_NAME;
  const defaultActionCell = document.createElement("td");
  defaultActionCell.textContent = "—";
  defaultRow.append(defaultNameCell, defaultActionCell);
  elements.calcPresetManageTableBody.appendChild(defaultRow);

  for (const name of Object.keys(state.calcPresets).sort()) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = name;
    nameCell.title = "Click to rename";
    nameCell.style.cursor = "pointer";
    nameCell.addEventListener("click", () => startCalcPresetNameEdit(nameCell, name));

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`Delete calculated attribute preset "${name}"?`)) {
        deleteCalcPresetByName(name);
      }
    });
    actionCell.appendChild(deleteBtn);
    row.append(nameCell, actionCell);
    elements.calcPresetManageTableBody.appendChild(row);
  }
}

function openManageCalcPresetsDialog() {
  if (!elements.manageCalcPresetsDialog) return;
  renderCalcPresetManageTable();
  elements.manageCalcPresetsDialog.showModal();
}

function closeManageCalcPresetsDialog() {
  elements.manageCalcPresetsDialog?.close();
}

function buildColumnOrderTree(columns, level = 0) {
  const nodes = [];
  let i = 0;

  while (i < columns.length) {
    const column = columns[i];
    const parts = getColumnPathParts(column);
    const n = parts.length;

    if (n === 1) {
      nodes.push({ type: "item", column });
      i += 1;
      continue;
    }

    if (level >= n - 1) {
      nodes.push({ type: "item", column });
      i += 1;
      continue;
    }

    const prefixKey = parts.slice(0, level + 1).join("\0");
    let j = i + 1;
    while (j < columns.length) {
      const nextParts = getColumnPathParts(columns[j]);
      if (nextParts.length === 1) break;
      if (level >= nextParts.length - 1) break;
      const nextPrefix = nextParts.slice(0, level + 1).join("\0");
      if (nextPrefix !== prefixKey) break;
      j += 1;
    }

    const segment = columns.slice(i, j);
    const groupId = parts.slice(0, level + 1).join(".");
    const label = parts[level];

    if (segment.length === 1 && level < n - 2) {
      nodes.push({
        type: "group",
        id: groupId,
        label,
        columns: segment,
        children: buildColumnOrderTree(segment, level + 1),
      });
    } else if (segment.length === 1) {
      nodes.push({ type: "item", column: segment[0] });
    } else {
      nodes.push({
        type: "group",
        id: groupId,
        label,
        columns: segment,
        children: buildColumnOrderTree(segment, level + 1),
      });
    }
    i = j;
  }

  return nodes;
}

function collectColumnOrderGroupIds(nodes, ids = []) {
  for (const node of nodes) {
    if (node.type === "group") {
      ids.push(node.id);
      collectColumnOrderGroupIds(node.children, ids);
    }
  }
  return ids;
}

function isColumnOrderIndexInDragBlock(index, dragState) {
  if (!dragState) return false;
  return index >= dragState.flatStartIndex && index < dragState.flatStartIndex + dragState.flatCount;
}

function shouldUseRootLevelInsertion(dragState) {
  if (!dragState?.item) return true;
  if (dragState.item.classList.contains("column-order-group-header")) return true;
  if (dragState.flatCount > 1) return true;
  return !dragState.item.closest(".column-order-group-children");
}

function getColumnOrderRootDropZones(list, dragState) {
  const zones = [];

  for (const child of list.children) {
    if (child.classList.contains("column-order-placeholder")) continue;

    if (child.classList.contains("column-order-item")) {
      const flatIndex = Number(child.dataset.flatIndex);
      if (child === dragState?.item) continue;
      if (isColumnOrderIndexInDragBlock(flatIndex, dragState)) continue;
      zones.push({ element: child, flatIndex, flatCount: 1 });
      continue;
    }

    if (child.classList.contains("column-order-group")) {
      const header = child.querySelector(".column-order-group-header");
      if (!header) continue;
      const flatStart = Number(header.dataset.flatStart);
      const flatCount = Number(header.dataset.flatCount);
      if (header === dragState?.item) continue;
      if (isColumnOrderIndexInDragBlock(flatStart, dragState)) continue;
      zones.push({ element: child, flatIndex: flatStart, flatCount });
    }
  }

  return zones;
}

function getColumnOrderDragTargets(container, dragState) {
  const targets = [];

  function walk(list) {
    for (const child of list.children) {
      if (child.classList.contains("column-order-placeholder")) continue;
      if (child.classList.contains("column-order-item")) {
        const flatIndex = Number(child.dataset.flatIndex);
        if (child === dragState?.item) continue;
        if (isColumnOrderIndexInDragBlock(flatIndex, dragState)) continue;
        targets.push({ element: child, flatIndex, flatCount: 1 });
        continue;
      }

      if (child.classList.contains("column-order-group")) {
        const header = child.querySelector(".column-order-group-header");
        if (!header) continue;
        const flatStart = Number(header.dataset.flatStart);
        const flatCount = Number(header.dataset.flatCount);
        const collapsed = child.classList.contains("is-collapsed");
        const draggingThisGroup = dragState?.item === header;

        if (collapsed) {
          if (draggingThisGroup) continue;
          if (isColumnOrderIndexInDragBlock(flatStart, dragState)) continue;
          targets.push({ element: header, flatIndex: flatStart, flatCount });
          continue;
        }

        if (!draggingThisGroup) {
          walk(child.querySelector(".column-order-group-children"));
        }
      }
    }
  }

  walk(container);
  return targets;
}

function getColumnOrderFlatInsertIndex(list, clientY, dragState) {
  if (shouldUseRootLevelInsertion(dragState)) {
    const zones = getColumnOrderRootDropZones(list, dragState);
    for (const zone of zones) {
      const rect = zone.element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return zone.flatIndex;
      }
    }
    if (zones.length === 0) return dragState.flatStartIndex;
    const last = zones[zones.length - 1];
    return last.flatIndex + last.flatCount;
  }

  const targets = getColumnOrderDragTargets(list, dragState);
  for (const target of targets) {
    const rect = target.element.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return target.flatIndex;
    }
  }
  if (targets.length === 0) return dragState.flatStartIndex;
  const last = targets[targets.length - 1];
  return last.flatIndex + last.flatCount;
}

function resolveColumnOrderInsertionPoint(flatInsertIndex, dragState) {
  const list = elements.columnOrderList;
  const rootLevelOnly = shouldUseRootLevelInsertion(dragState);

  function walk(parentList) {
    for (const child of parentList.children) {
      if (child.classList.contains("column-order-placeholder")) continue;

      if (child.classList.contains("column-order-item")) {
        const flatIndex = Number(child.dataset.flatIndex);
        if (flatInsertIndex <= flatIndex) {
          return { parent: parentList, before: child };
        }
        continue;
      }

      if (child.classList.contains("column-order-group")) {
        const header = child.querySelector(".column-order-group-header");
        const flatStart = Number(header.dataset.flatStart);
        const flatCount = Number(header.dataset.flatCount);
        const flatEnd = flatStart + flatCount;

        if (flatInsertIndex < flatStart) {
          return { parent: parentList, before: child };
        }

        if (flatInsertIndex >= flatEnd) {
          continue;
        }

        if (rootLevelOnly) {
          return { parent: parentList, before: child };
        }

        const nestedPoint = walk(child.querySelector(".column-order-group-children"));
        if (nestedPoint) return nestedPoint;
      }
    }

    return { parent: parentList, before: null };
  }

  return walk(list);
}

function ensureColumnOrderPlaceholder(list, labelText = "") {
  let placeholder = list.querySelector(".column-order-placeholder");
  if (!placeholder) {
    placeholder = document.createElement("li");
    placeholder.className = "column-order-placeholder";
    placeholder.setAttribute("aria-hidden", "true");

    const handle = document.createElement("span");
    handle.className = "column-order-handle";
    handle.textContent = "⋮⋮";
    handle.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "column-order-label";

    placeholder.append(handle, label);
  }

  const label = placeholder.querySelector(".column-order-label");
  if (label) {
    label.textContent = labelText;
  }

  return placeholder;
}

function mountColumnOrderPlaceholder(list, flatInsertIndex, dragState) {
  if (dragState?.lastInsertIndex === flatInsertIndex) return;

  const placeholder = ensureColumnOrderPlaceholder(list, dragState.labelText);
  const { parent, before } = resolveColumnOrderInsertionPoint(flatInsertIndex, dragState);

  if (before) {
    parent.insertBefore(placeholder, before);
  } else {
    parent.appendChild(placeholder);
  }

  placeholder.classList.add("is-open");
  dragState.lastInsertIndex = flatInsertIndex;
}

function cleanupColumnOrderDrag() {
  const list = elements.columnOrderList;
  if (list) {
    list.classList.remove("is-dragging");
    list.style.removeProperty("--column-order-item-height");
    list.querySelectorAll(".column-order-placeholder").forEach((node) => node.remove());
    list.querySelectorAll(".column-order-group.is-dragging-group").forEach((node) => {
      node.classList.remove("is-dragging-group");
    });
  }
  if (columnOrderDragState?.item) {
    columnOrderDragState.item.classList.remove("is-dragging");
    columnOrderDragState.item.releasePointerCapture?.(columnOrderDragState.pointerId);
  }
  columnOrderDragState = null;
}

function onColumnOrderPointerMove(event) {
  if (!columnOrderDragState || event.pointerId !== columnOrderDragState.pointerId) return;
  const { item } = columnOrderDragState;
  const list = elements.columnOrderList;
  if (!list) return;
  const insertIndex = getColumnOrderFlatInsertIndex(list, event.clientY, columnOrderDragState);
  mountColumnOrderPlaceholder(list, insertIndex, columnOrderDragState);
}

function finishColumnOrderDrag(event) {
  if (!columnOrderDragState || event.pointerId !== columnOrderDragState.pointerId) return;

  const { flatStartIndex, flatCount, item } = columnOrderDragState;
  const dropIndex = columnOrderDragState.lastInsertIndex ?? flatStartIndex;

  item.removeEventListener("pointermove", onColumnOrderPointerMove);
  item.removeEventListener("pointerup", finishColumnOrderDrag);
  item.removeEventListener("pointercancel", finishColumnOrderDrag);

  cleanupColumnOrderDrag();

  if (dropIndex !== flatStartIndex) {
    reorderVisibleColumnBlock(flatStartIndex, flatCount, dropIndex);
  } else {
    renderColumnOrderList();
  }
}

function startColumnOrderDrag(event, element, flatStartIndex, flatCount, labelText) {
  if (event.button !== 0) return;
  const list = elements.columnOrderList;
  if (!list || columnOrderDragState) return;

  event.preventDefault();
  element.setPointerCapture(event.pointerId);

  const itemHeight = element.getBoundingClientRect().height;
  list.style.setProperty("--column-order-item-height", `${Math.round(itemHeight)}px`);
  list.classList.add("is-dragging");
  element.classList.add("is-dragging");
  const groupEl = element.closest(".column-order-group");
  if (groupEl && flatCount > 1) {
    groupEl.classList.add("is-dragging-group");
  }

  columnOrderDragState = {
    flatStartIndex,
    flatCount,
    item: element,
    pointerId: event.pointerId,
    lastInsertIndex: null,
    labelText,
  };
  mountColumnOrderPlaceholder(list, flatStartIndex, columnOrderDragState);
  columnOrderDragState.lastInsertIndex = flatStartIndex;

  element.addEventListener("pointermove", onColumnOrderPointerMove);
  element.addEventListener("pointerup", finishColumnOrderDrag);
  element.addEventListener("pointercancel", finishColumnOrderDrag);
}

function reorderVisibleColumnBlock(fromStart, count, toIndex) {
  if (count <= 0 || fromStart === toIndex) return;
  const columns = [...state.visibleColumns];
  if (toIndex > fromStart && toIndex <= fromStart + count) {
    renderColumnOrderList();
    return;
  }
  const block = columns.splice(fromStart, count);
  let insertAt = toIndex;
  if (toIndex > fromStart) insertAt -= count;
  columns.splice(insertAt, 0, ...block);
  setVisibleColumns(columns);
}

function reorderVisibleColumns(fromIndex, toIndex) {
  reorderVisibleColumnBlock(fromIndex, 1, toIndex);
}

function toggleColumnOrderGroup(groupId) {
  if (state.collapsedColumnOrderGroups.has(groupId)) {
    state.collapsedColumnOrderGroups.delete(groupId);
  } else {
    state.collapsedColumnOrderGroups.add(groupId);
  }
  renderColumnOrderList();
  saveSessionState();
}

function setAllColumnOrderGroupsExpanded(expanded) {
  const tree = buildColumnOrderTree(state.visibleColumns);
  const groupIds = collectColumnOrderGroupIds(tree);
  state.collapsedColumnOrderGroups.clear();
  if (!expanded) {
    for (const groupId of groupIds) {
      state.collapsedColumnOrderGroups.add(groupId);
    }
  }
  renderColumnOrderList();
  saveSessionState();
}

function createColumnOrderToggleBtn(groupId, expanded) {
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "column-order-toggle-btn";
  toggleBtn.textContent = expanded ? "▾" : "▸";
  toggleBtn.title = expanded ? "Collapse group" : "Expand group";
  toggleBtn.setAttribute("aria-expanded", String(expanded));
  toggleBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleColumnOrderGroup(groupId);
  });
  toggleBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
  return toggleBtn;
}

function createColumnOrderItem(column, flatIndex) {
  const item = document.createElement("li");
  item.className = "column-order-item";
  item.dataset.column = column;
  item.dataset.flatIndex = String(flatIndex);

  const handle = document.createElement("span");
  handle.className = "column-order-handle";
  handle.textContent = "⋮⋮";
  handle.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "column-order-label";
  label.textContent = formatAttributeFullPath(column);

  item.append(handle, label);

  item.addEventListener("pointerdown", (event) => {
    startColumnOrderDrag(event, item, flatIndex, 1, formatAttributeFullPath(column));
  });

  return item;
}

function createColumnOrderGroupHeader(node, flatStart, flatCount) {
  const collapsed = state.collapsedColumnOrderGroups.has(node.id);
  const header = document.createElement("div");
  header.className = "column-order-group-header";
  header.dataset.flatStart = String(flatStart);
  header.dataset.flatCount = String(flatCount);

  const toggleBtn = createColumnOrderToggleBtn(node.id, !collapsed);

  const handle = document.createElement("span");
  handle.className = "column-order-handle";
  handle.textContent = "⋮⋮";
  handle.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "column-order-group-label";
  label.textContent = node.label;

  const count = document.createElement("span");
  count.className = "column-order-group-count";
  count.textContent = String(flatCount);

  header.append(toggleBtn, handle, label, count);

  const dragLabel = `${node.label} (${flatCount})`;
  header.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".column-order-toggle-btn")) return;
    startColumnOrderDrag(event, header, flatStart, flatCount, dragLabel);
  });

  return header;
}

function renderColumnOrderNode(node, flatIndexRef, container) {
  if (node.type === "item") {
    const item = createColumnOrderItem(node.column, flatIndexRef.value);
    flatIndexRef.value += 1;
    container.appendChild(item);
    return;
  }

  const collapsed = state.collapsedColumnOrderGroups.has(node.id);
  const flatStart = flatIndexRef.value;
  const flatCount = node.columns.length;

  const group = document.createElement("li");
  group.className = "column-order-group";
  group.dataset.groupId = node.id;
  group.classList.toggle("is-collapsed", collapsed);

  const header = createColumnOrderGroupHeader(node, flatStart, flatCount);
  group.appendChild(header);

  const childList = document.createElement("ul");
  childList.className = "column-order-group-children";
  childList.hidden = collapsed;

  const childRef = { value: flatStart };
  for (const child of node.children) {
    renderColumnOrderNode(child, childRef, childList);
  }
  flatIndexRef.value = flatStart + flatCount;

  group.appendChild(childList);
  container.appendChild(group);
}

function renderColumnOrderList() {
  if (!elements.columnOrderList) return;
  cleanupColumnOrderDrag();
  elements.columnOrderList.innerHTML = "";

  if (state.visibleColumns.length === 0) {
    const empty = document.createElement("li");
    empty.className = "column-order-empty";
    empty.textContent = "No visible attributes. Use Attribute selector to choose columns.";
    elements.columnOrderList.appendChild(empty);
    return;
  }

  const tree = buildColumnOrderTree(state.visibleColumns);
  const flatIndexRef = { value: 0 };
  for (const node of tree) {
    renderColumnOrderNode(node, flatIndexRef, elements.columnOrderList);
  }
}

function getCalcColumnNameSet() {
  return new Set(state.calculatedColumns.map((definition) => definition.name).filter(Boolean));
}

function insertCalcColumnsIntoVisibleColumns(columns, namesToAdd) {
  const calcNames = getCalcColumnNameSet();
  const toInsert = namesToAdd.filter((name) => name && !columns.includes(name));
  if (toInsert.length === 0) return columns;

  const next = [...columns];
  const weaponIndex = next.indexOf("weaponName");
  let insertAt = weaponIndex >= 0 ? weaponIndex + 1 : 0;
  while (insertAt < next.length && calcNames.has(next[insertAt])) {
    insertAt += 1;
  }
  next.splice(insertAt, 0, ...toInsert);
  return next;
}

function getDefaultVisibleColumnOrder(columns) {
  const visible = columns.filter((column) => state.availableColumns.includes(column));
  const visibleSet = new Set(visible);
  const calcNames = getCalcColumnNameSet();
  const ordered = [];

  if (visibleSet.has("weaponName")) {
    ordered.push("weaponName");
  }

  for (const definition of state.calculatedColumns) {
    const name = definition.name;
    if (name && visibleSet.has(name) && calcNames.has(name)) {
      ordered.push(name);
    }
  }

  for (const column of CORE_COLUMNS) {
    if (column === "weaponName" || calcNames.has(column)) continue;
    if (visibleSet.has(column)) ordered.push(column);
  }

  for (const column of state.availableColumns) {
    if (visibleSet.has(column) && !ordered.includes(column)) {
      ordered.push(column);
    }
  }

  return ordered;
}

function insertVisibleColumnsAtDefaultPositions(columns, namesToAdd) {
  const pending = namesToAdd.filter((name) => name && !columns.includes(name));
  if (pending.length === 0) return columns;

  const orderedToAdd = getDefaultVisibleColumnOrder([...columns, ...pending]).filter((name) =>
    pending.includes(name),
  );

  const next = [...columns];
  for (const name of orderedToAdd) {
    const defaultOrder = getDefaultVisibleColumnOrder([...next, name]);
    const targetIndex = defaultOrder.indexOf(name);
    let insertAt = 0;
    for (let i = 0; i < targetIndex; i += 1) {
      const col = defaultOrder[i];
      const idxInNext = next.indexOf(col);
      if (idxInNext >= 0) {
        insertAt = idxInNext + 1;
      }
    }
    next.splice(insertAt, 0, name);
  }

  return next;
}

function addVisibleColumnsInDefaultOrder(columnsToAdd) {
  setVisibleColumns(insertVisibleColumnsAtDefaultPositions(state.visibleColumns, columnsToAdd));
}

function resetVisibleColumnOrder() {
  setVisibleColumns(getDefaultVisibleColumnOrder(state.visibleColumns));
}

function setVisibleColumns(columns) {
  const valid = ensureRequiredVisibleColumns(columns.filter((c) => state.availableColumns.includes(c)));
  state.visibleColumns = valid.length ? valid : ["weaponName", "faction", "category"];
  if (!state.visibleColumns.includes(state.sortKey)) {
    state.sortKey = state.visibleColumns[0];
    state.sortDirection = "asc";
  }
  renderColumnChooser();
  renderFilterTable();
  renderCalcTable();
  renderTable();
  if (activeDrawerPanel === "column-order") {
    renderColumnOrderList();
  }
  saveSessionState();
}

function bindEvent(element, eventName, handler, label = eventName) {
  if (!element) {
    console.warn(`[viewer] Missing #${label} — skipped "${eventName}" listener. Hard-refresh if you renamed controls.`);
    return;
  }
  element.addEventListener(eventName, handler);
}

function reportMissingElements() {
  const missing = Object.entries(elements)
    .filter(([key, el]) => {
      if (key === "drawerTriggers" || key === "topDrawers") return el.length === 0;
      return !el;
    })
    .map(([key]) => key);
  if (missing.length) {
    console.error("[viewer] Missing DOM elements:", missing.join(", "));
  }
}

function getTopDrawer(panelId) {
  return document.querySelector(`.top-drawer[data-drawer-panel="${panelId}"]`);
}

function updateDrawerTriggerStates(panelId) {
  elements.drawerTriggers.forEach((button) => {
    const isActive = Boolean(panelId) && button.dataset.drawerPanel === panelId;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-expanded", String(isActive));
  });
}

function openTopDrawer(panelId) {
  if (!panelId) return;
  if (activeDrawerPanel === panelId) {
    closeTopDrawer();
    return;
  }
  closeTopDrawer();
  const drawer = getTopDrawer(panelId);
  if (!drawer) return;
  activeDrawerPanel = panelId;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  if (panelId === "filters") {
    renderFilterTable();
  }
  if (panelId === "column-order") {
    renderColumnOrderList();
  }
  if (panelId === "calculated") {
    renderCalcTable();
  }
  elements.topDrawerBackdrop?.classList.add("is-visible");
  elements.topDrawerBackdrop?.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  updateDrawerTriggerStates(panelId);
}

function closeTopDrawer() {
  cleanupColumnOrderDrag();
  detachOrphanedFloatingAttributeLists();
  elements.topDrawers.forEach((drawer) => {
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
  });
  elements.topDrawerBackdrop?.classList.remove("is-visible");
  elements.topDrawerBackdrop?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  activeDrawerPanel = null;
  updateDrawerTriggerStates(null);
}

function wireDrawerEvents() {
  elements.drawerTriggers.forEach((button) => {
    button.addEventListener("click", () => {
      const panelId = button.dataset.drawerPanel;
      if (panelId) openTopDrawer(panelId);
    });
  });
  elements.topDrawerBackdrop?.addEventListener("click", closeTopDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTopDrawer();
  });
}

function wireEvents() {
  bindEvent(elements.searchInput, "input", applyFiltersAndSort, "searchInput");
  bindEvent(elements.factionFilter, "change", applyFiltersAndSort, "factionFilter");
  bindEvent(elements.categoryFilter, "change", applyFiltersAndSort, "categoryFilter");
  bindEvent(elements.versionSelect, "change", () => {
    const nextTag = elements.versionSelect?.value;
    if (!nextTag || nextTag === state.activeVersionTag) return;
    reloadWeaponVersion(nextTag);
  }, "versionSelect");
  bindEvent(elements.rowsPerPage, "change", () => {
    state.rowsPerPage = Number(elements.rowsPerPage.value) || 50;
    state.currentPage = 1;
    renderTable();
    saveSessionState();
  }, "rowsPerPage");
  bindEvent(elements.prevPageBtn, "click", () => {
    if (state.currentPage > 1) {
      state.currentPage -= 1;
      renderTable();
    }
  }, "prevPageBtn");
  bindEvent(elements.nextPageBtn, "click", () => {
    const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / state.rowsPerPage));
    if (state.currentPage < totalPages) {
      state.currentPage += 1;
      renderTable();
    }
  }, "nextPageBtn");
  bindEvent(elements.attributeSearchInput, "input", renderAttributeChooser, "attributeSearchInput");
  bindEvent(elements.presetSelect, "change", () => {
    if (suppressPresetSelectChange) return;
    loadPresetByName(getSelectedPresetName());
  }, "presetSelect");
  bindEvent(elements.showAllAttributesBtn, "click", () => setVisibleColumns(getDefaultVisibleColumnOrder(state.availableColumns)), "showAllAttributesBtn");
  bindEvent(elements.clearAttributesBtn, "click", () => setVisibleColumns(["weaponName", "faction", "category"]), "clearAttributesBtn");
  bindEvent(elements.expandAllGroupsBtn, "click", () => setAllAttributeGroupsExpanded(true), "expandAllGroupsBtn");
  bindEvent(elements.collapseAllGroupsBtn, "click", () => setAllAttributeGroupsExpanded(false), "collapseAllGroupsBtn");
  bindEvent(elements.addFilterBtn, "click", addNewFilterRow, "addFilterBtn");
  bindEvent(elements.activateAllFiltersBtn, "click", activateAllFilters, "activateAllFiltersBtn");
  bindEvent(elements.deactivateAllFiltersBtn, "click", deactivateAllFilters, "deactivateAllFiltersBtn");
  bindEvent(elements.filterPresetSelect, "change", () => {
    if (suppressFilterPresetSelectChange) return;
    loadFilterPresetByName(getSelectedFilterPresetName());
  }, "filterPresetSelect");
  bindEvent(elements.saveFilterPresetBtn, "click", saveNamedFilterPreset, "saveFilterPresetBtn");
  bindEvent(elements.manageFilterPresetsBtn, "click", openManageFilterPresetsDialog, "manageFilterPresetsBtn");
  bindEvent(elements.closeManageFilterPresetsBtn, "click", closeManageFilterPresetsDialog, "closeManageFilterPresetsBtn");
  elements.manageFilterPresetsDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeManageFilterPresetsDialog();
  });
  bindEvent(elements.savePresetBtn, "click", saveNamedPreset, "savePresetBtn");
  bindEvent(elements.managePresetsBtn, "click", openManagePresetsDialog, "managePresetsBtn");
  bindEvent(elements.closeManagePresetsBtn, "click", closeManagePresetsDialog, "closeManagePresetsBtn");
  elements.managePresetsDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeManagePresetsDialog();
  });
  bindEvent(elements.addCalcColumnBtn, "click", addNewCalcRow, "addCalcColumnBtn");
  bindEvent(elements.displayAllCalcBtn, "click", displayAllCalculatedColumns, "displayAllCalcBtn");
  bindEvent(elements.clearCalcColumnsBtn, "click", clearAllCalculatedColumns, "clearCalcColumnsBtn");
  bindEvent(elements.calcPresetSelect, "change", () => {
    if (suppressCalcPresetSelectChange) return;
    loadCalcPresetByName(getSelectedCalcPresetName());
  }, "calcPresetSelect");
  bindEvent(elements.saveCalcPresetBtn, "click", saveNamedCalcPreset, "saveCalcPresetBtn");
  bindEvent(elements.manageCalcPresetsBtn, "click", openManageCalcPresetsDialog, "manageCalcPresetsBtn");
  bindEvent(elements.closeManageCalcPresetsBtn, "click", closeManageCalcPresetsDialog, "closeManageCalcPresetsBtn");
  elements.manageCalcPresetsDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeManageCalcPresetsDialog();
  });
  bindEvent(elements.exportCsvBtn, "click", exportFilteredRowsToCsv, "exportCsvBtn");
  bindEvent(elements.resetColumnOrderBtn, "click", resetVisibleColumnOrder, "resetColumnOrderBtn");
  bindEvent(elements.expandColumnOrderGroupsBtn, "click", () => setAllColumnOrderGroupsExpanded(true), "expandColumnOrderGroupsBtn");
  bindEvent(elements.collapseColumnOrderGroupsBtn, "click", () => setAllColumnOrderGroupsExpanded(false), "collapseColumnOrderGroupsBtn");
  wireDrawerEvents();
}

function fillStaticIdentityRegistry() {
  [
    ["weaponName", "string"],
    ["faction", "string"],
    ["category", "string"],
  ].forEach(([path, type]) => {
    state.schemaRegistry.set(path, { path, type, presence: state.rows.length, sample: "" });
  });
}

function rebuildWeaponRowsFromData(data) {
  state.schemaRegistry = new Map();
  state.rows = flattenWeapons(data);
  fillStaticIdentityRegistry();
  buildAvailableColumns();
  computeScalarColumnDisplayWidths();
  fillSelectOptions(
    elements.factionFilter,
    [...new Set(state.rows.map((row) => row.faction).filter(Boolean))].sort(),
    "All factions",
  );
  fillSelectOptions(
    elements.categoryFilter,
    [...new Set(state.rows.map((row) => row.category).filter(Boolean))].sort(),
    "All categories",
  );
}

async function loadWeaponDataset() {
  const overrideUrl = getUrlParams().get("data");
  if (overrideUrl) {
    weaponHistoryEnabled = false;
    hideVersionSelect();
    elements.statusText.textContent = `Loading weapon data from ${overrideUrl}...`;
    const data = await loadWeaponData(overrideUrl);
    state.activeVersionTag = null;
    return data;
  }

  weaponHistoryManifest = await loadWeaponHistoryManifest();
  if (weaponHistoryManifest) {
    weaponHistoryEnabled = true;
    const session = loadSessionState();
    const versionTag = resolveInitialVersionTag(session);
    renderVersionSelect(versionTag);
    elements.statusText.textContent = `Loading weapon data (${versionTag})...`;
    setVersionSelectBusy(true);
    const data = await loadWeaponDataForVersion(versionTag);
    state.activeVersionTag = versionTag;
    return data;
  }

  weaponHistoryEnabled = false;
  hideVersionSelect();
  const fallbackUrl = resolveWeaponDataUrl();
  elements.statusText.textContent = `Loading weapon data from ${fallbackUrl}...`;
  const data = await loadWeaponData(fallbackUrl);
  state.activeVersionTag = null;
  return data;
}

async function reloadWeaponVersion(tag) {
  if (!weaponHistoryEnabled || !weaponHistoryManifest) return;

  const preserved = snapshotCurrentState();
  setVersionSelectBusy(true);
  elements.statusText.textContent = `Loading weapon data (${tag})...`;

  try {
    const data = await loadWeaponDataForVersion(tag);
    state.activeVersionTag = tag;
    rebuildWeaponRowsFromData(data);
    preserved.visibleColumns = preserved.visibleColumns.filter((column) => state.availableColumns.includes(column));
    preserved.pinnedRowKeys = preserved.pinnedRowKeys.filter((key) => findRowByKey(key));
    applySnapshot(preserved);
    if (elements.versionSelect) {
      elements.versionSelect.value = tag;
    }
    saveSessionState();
  } catch (error) {
    console.error(error);
    elements.statusText.textContent = `Failed to load weapon data (${tag}).`;
    if (elements.versionSelect) {
      elements.versionSelect.value = state.activeVersionTag || weaponHistoryManifest.latestTag;
    }
  } finally {
    setVersionSelectBusy(false);
  }
}

async function init() {
  reportMissingElements();
  wireEvents();
  if (!elements.statusText) {
    console.error("[viewer] Cannot start without #statusText.");
    return;
  }

  try {
    const data = await loadWeaponDataset();
    elements.statusText.textContent = "Flattening weapon records...";
    rebuildWeaponRowsFromData(data);
    state.filteredRows = [...state.rows];

    loadPresets();
    loadFilterPresets();
    loadCalcPresets();
    renderPresetOptions(DEFAULT_PRESET_NAME);
    renderFilterPresetOptions(DEFAULT_FILTER_PRESET_NAME);
    renderCalcPresetOptions(DEFAULT_CALC_PRESET_NAME);
    renderFilterTable();
    renderCalculatedColumns();

    const session = loadSessionState();
    if (session) {
      applySnapshot(session);
      renderPresetOptions(state.activePresetName);
      renderFilterPresetOptions(state.activeFilterPresetName);
      renderCalcPresetOptions(state.activeCalcPresetName);
      if (weaponHistoryEnabled && session.activeVersionTag && elements.versionSelect) {
        elements.versionSelect.value = session.activeVersionTag;
      }
    } else {
      applyDefaultPreset();
      applyDefaultFilterPreset();
      applyDefaultCalcPreset();
      renderPresetOptions(DEFAULT_PRESET_NAME);
      renderFilterPresetOptions(DEFAULT_FILTER_PRESET_NAME);
      renderCalcPresetOptions(DEFAULT_CALC_PRESET_NAME);
    }

    if (weaponHistoryEnabled && state.activeVersionTag) {
      elements.statusText.textContent = `Loaded ${state.rows.length} weapons from ${state.activeVersionTag}.`;
    }

    setVersionSelectBusy(false);
    saveSessionState();
  } catch (error) {
    console.error(error);
    elements.statusText.textContent = "Failed to load weapon data. Run locally with a web server (not file://).";
    setVersionSelectBusy(false);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
