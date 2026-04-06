const ADMIN_KEY_STORAGE_KEY = 'karakuri-world-admin-key';
const NODE_TYPES = ['normal', 'wall', 'door', 'building_interior', 'npc'];
const NODE_TYPE_LABELS = {
  normal: 'normal',
  wall: 'wall',
  door: 'door',
  building_interior: 'building_interior',
  npc: 'npc',
};
const NODE_TYPE_COLORS = {
  normal: '#1f2937',
  wall: '#6b7280',
  door: '#f59e0b',
  building_interior: '#2563eb',
  npc: '#8b5cf6',
};
const DEFAULT_CELL_SIZE = 40;

const state = {
  adminKey: sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? '',
  config: null,
  selectedNodeId: null,
  activeTool: 'normal',
  activeBuildingId: null,
  activeNpcId: null,
  validationIssues: [],
  cellSize: DEFAULT_CELL_SIZE,
  isPainting: false,
};

const elements = {
  app: document.querySelector('#app'),
  authDialog: document.querySelector('#auth-dialog'),
  authForm: document.querySelector('#auth-form'),
  adminKeyInput: document.querySelector('#admin-key-input'),
  statusText: document.querySelector('#status-text'),
  reloadButton: document.querySelector('#reload-button'),
  validateButton: document.querySelector('#validate-button'),
  saveButton: document.querySelector('#save-button'),
  clearValidationButton: document.querySelector('#clear-validation-button'),
  tilePalette: document.querySelector('#tile-palette'),
  gridCanvas: document.querySelector('#grid-canvas'),
  selectionSummary: document.querySelector('#selection-summary'),
  cellSizeInput: document.querySelector('#cell-size-input'),
  buildingSelect: document.querySelector('#building-select'),
  addBuildingButton: document.querySelector('#add-building-button'),
  deleteBuildingButton: document.querySelector('#delete-building-button'),
  npcSelect: document.querySelector('#npc-select'),
  addNpcButton: document.querySelector('#add-npc-button'),
  deleteNpcButton: document.querySelector('#delete-npc-button'),
  nodeIdInput: document.querySelector('#node-id-input'),
  nodeTypeSelect: document.querySelector('#node-type-select'),
  nodeLabelInput: document.querySelector('#node-label-input'),
  nodeBuildingSelect: document.querySelector('#node-building-select'),
  nodeNpcSelect: document.querySelector('#node-npc-select'),
  buildingIdInput: document.querySelector('#building-id-input'),
  buildingNameInput: document.querySelector('#building-name-input'),
  buildingDescriptionInput: document.querySelector('#building-description-input'),
  buildingWallNodes: document.querySelector('#building-wall-nodes'),
  buildingInteriorNodes: document.querySelector('#building-interior-nodes'),
  buildingDoorNodes: document.querySelector('#building-door-nodes'),
  addBuildingActionButton: document.querySelector('#add-building-action-button'),
  buildingActionsList: document.querySelector('#building-actions-list'),
  npcIdInput: document.querySelector('#npc-id-input'),
  npcNameInput: document.querySelector('#npc-name-input'),
  npcDescriptionInput: document.querySelector('#npc-description-input'),
  npcNodeIdInput: document.querySelector('#npc-node-id-input'),
  addNpcActionButton: document.querySelector('#add-npc-action-button'),
  npcActionsList: document.querySelector('#npc-actions-list'),
  worldNameInput: document.querySelector('#world-name-input'),
  worldSkillNameInput: document.querySelector('#world-skill-name-input'),
  worldDescriptionInput: document.querySelector('#world-description-input'),
  mapRowsInput: document.querySelector('#map-rows-input'),
  mapColsInput: document.querySelector('#map-cols-input'),
  movementDurationInput: document.querySelector('#movement-duration-input'),
  conversationMaxTurnsInput: document.querySelector('#conversation-max-turns-input'),
  conversationIntervalInput: document.querySelector('#conversation-interval-input'),
  conversationAcceptTimeoutInput: document.querySelector('#conversation-accept-timeout-input'),
  conversationTurnTimeoutInput: document.querySelector('#conversation-turn-timeout-input'),
  perceptionRangeInput: document.querySelector('#perception-range-input'),
  spawnNodesInput: document.querySelector('#spawn-nodes-input'),
  idleReminderEnabledInput: document.querySelector('#idle-reminder-enabled-input'),
  idleReminderIntervalInput: document.querySelector('#idle-reminder-interval-input'),
  validationResults: document.querySelector('#validation-results'),
};

function deepClone(value) {
  return structuredClone(value);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function parseNodeId(nodeId) {
  const [rowText, colText] = nodeId.split('-');
  return {
    row: Number.parseInt(rowText, 10),
    col: Number.parseInt(colText, 10),
  };
}

function toNodeId(row, col) {
  return `${row}-${col}`;
}

function compareNodeIds(left, right) {
  const leftNode = parseNodeId(left);
  const rightNode = parseNodeId(right);
  if (leftNode.row !== rightNode.row) {
    return leftNode.row - rightNode.row;
  }
  return leftNode.col - rightNode.col;
}

function getNodeConfig(nodeId) {
  return state.config?.map.nodes[nodeId] ?? { type: 'normal' };
}

function normalizeNodeConfig(nodeConfig) {
  const normalized = {
    type: nodeConfig.type ?? 'normal',
    ...(nodeConfig.label ? { label: nodeConfig.label } : {}),
    ...(nodeConfig.building_id ? { building_id: nodeConfig.building_id } : {}),
    ...(nodeConfig.npc_id ? { npc_id: nodeConfig.npc_id } : {}),
  };

  return normalized.type === 'normal' && !normalized.label && !normalized.building_id && !normalized.npc_id
    ? null
    : normalized;
}

function setNodeConfig(nodeId, nodeConfig) {
  const normalized = normalizeNodeConfig(nodeConfig);
  if (normalized) {
    state.config.map.nodes[nodeId] = normalized;
  } else {
    delete state.config.map.nodes[nodeId];
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function showApp() {
  elements.authDialog.classList.add('hidden');
  elements.app.classList.remove('hidden');
}

function showAuthDialog(message) {
  if (message) {
    setStatus(message);
  }
  elements.app.classList.add('hidden');
  elements.authDialog.classList.remove('hidden');
  elements.adminKeyInput.value = '';
  elements.adminKeyInput.focus();
}

async function readJson(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function apiRequest(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('X-Admin-Key', state.adminKey);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });
  const data = await readJson(response);

  if (response.status === 401) {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
    state.adminKey = '';
    showAuthDialog('管理キーが無効です。再入力してください。');
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = new Error(typeof data === 'object' && data && 'message' in data ? data.message : 'Request failed.');
    error.response = response;
    error.payload = data;
    throw error;
  }

  return data;
}

function generateUniqueId(prefix, existingIds) {
  let counter = 1;
  while (existingIds.has(`${prefix}-${counter}`)) {
    counter += 1;
  }
  return `${prefix}-${counter}`;
}

function getSelectedBuilding() {
  return state.config?.map.buildings.find((building) => building.building_id === state.activeBuildingId) ?? null;
}

function getSelectedNpc() {
  return state.config?.map.npcs.find((npc) => npc.npc_id === state.activeNpcId) ?? null;
}

function pruneNodesToBounds() {
  const nextNodes = {};
  for (const [nodeId, nodeConfig] of Object.entries(state.config.map.nodes)) {
    const { row, col } = parseNodeId(nodeId);
    if (row >= 1 && row <= state.config.map.rows && col >= 1 && col <= state.config.map.cols) {
      nextNodes[nodeId] = nodeConfig;
    }
  }
  state.config.map.nodes = nextNodes;
}

function commitMapSizeInputs() {
  const nextRows = parsePositiveInteger(elements.mapRowsInput.value, state.config.map.rows);
  const nextCols = parsePositiveInteger(elements.mapColsInput.value, state.config.map.cols);
  const changed = nextRows !== state.config.map.rows || nextCols !== state.config.map.cols;

  state.config.map.rows = nextRows;
  state.config.map.cols = nextCols;

  if (changed) {
    syncDerivedCollections();
  }
}

function syncDerivedCollections() {
  pruneNodesToBounds();

  for (const building of state.config.map.buildings) {
    building.wall_nodes = [];
    building.interior_nodes = [];
    building.door_nodes = [];
  }

  const npcNodeIds = new Map();

  for (const [nodeId, nodeConfig] of Object.entries(state.config.map.nodes)) {
    if (nodeConfig.building_id) {
      const building = state.config.map.buildings.find((candidate) => candidate.building_id === nodeConfig.building_id);
      if (building) {
        if (nodeConfig.type === 'wall') {
          building.wall_nodes.push(nodeId);
        } else if (nodeConfig.type === 'building_interior') {
          building.interior_nodes.push(nodeId);
        } else if (nodeConfig.type === 'door') {
          building.door_nodes.push(nodeId);
        }
      }
    }

    if (nodeConfig.type === 'npc' && nodeConfig.npc_id && !npcNodeIds.has(nodeConfig.npc_id)) {
      npcNodeIds.set(nodeConfig.npc_id, nodeId);
    }
  }

  for (const building of state.config.map.buildings) {
    building.wall_nodes.sort(compareNodeIds);
    building.interior_nodes.sort(compareNodeIds);
    building.door_nodes.sort(compareNodeIds);
  }

  for (const npc of state.config.map.npcs) {
    npc.node_id = npcNodeIds.get(npc.npc_id) ?? '';
  }

  if (state.activeBuildingId && !getSelectedBuilding()) {
    state.activeBuildingId = state.config.map.buildings[0]?.building_id ?? null;
  }
  if (state.activeNpcId && !getSelectedNpc()) {
    state.activeNpcId = state.config.map.npcs[0]?.npc_id ?? null;
  }
  if (state.selectedNodeId) {
    const { row, col } = parseNodeId(state.selectedNodeId);
    if (row > state.config.map.rows || col > state.config.map.cols) {
      state.selectedNodeId = null;
    }
  }
}

function setValidationIssues(issues, successMessage = null) {
  if (successMessage) {
    state.validationIssues = [{ path: 'ok', message: successMessage, success: true }];
  } else {
    state.validationIssues = issues.map((issue) => ({ ...issue, success: false }));
  }
  renderValidationResults();
}

function clearValidationIssues() {
  state.validationIssues = [];
  renderValidationResults();
}

function getCanvasNodeId(event) {
  const rect = elements.gridCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  const scaleX = elements.gridCanvas.width / rect.width;
  const scaleY = elements.gridCanvas.height / rect.height;
  const canvasX = (event.clientX - rect.left) * scaleX;
  const canvasY = (event.clientY - rect.top) * scaleY;
  const col = Math.floor(canvasX / state.cellSize) + 1;
  const row = Math.floor(canvasY / state.cellSize) + 1;

  if (row < 1 || col < 1 || row > state.config.map.rows || col > state.config.map.cols) {
    return null;
  }

  return toNodeId(row, col);
}

function removeNpcForNode(nodeConfig) {
  if (!nodeConfig.npc_id) {
    return;
  }

  state.config.map.npcs = state.config.map.npcs.filter((npc) => npc.npc_id !== nodeConfig.npc_id);
  if (state.activeNpcId === nodeConfig.npc_id) {
    state.activeNpcId = state.config.map.npcs[0]?.npc_id ?? null;
  }
}

function getReplacementNodeConfigForMovedNpc(nodeConfig) {
  if (nodeConfig.building_id) {
    return {
      type: 'building_interior',
      ...(nodeConfig.label ? { label: nodeConfig.label } : {}),
      building_id: nodeConfig.building_id,
    };
  }

  return {
    type: 'normal',
    ...(nodeConfig.label ? { label: nodeConfig.label } : {}),
  };
}

function clearNpcPlacement(npcId, nextNodeId) {
  for (const [nodeId, nodeConfig] of Object.entries(state.config.map.nodes)) {
    if (nodeId === nextNodeId || nodeConfig.type !== 'npc' || nodeConfig.npc_id !== npcId) {
      continue;
    }

    setNodeConfig(nodeId, getReplacementNodeConfigForMovedNpc(nodeConfig));
  }
}

function applyNodeUpdate(nodeId, nextNodeConfig) {
  const currentNodeConfig = getNodeConfig(nodeId);
  if (nextNodeConfig.type === 'npc' && nextNodeConfig.npc_id) {
    clearNpcPlacement(nextNodeConfig.npc_id, nodeId);
  }

  if (
    currentNodeConfig.type === 'npc'
    && (nextNodeConfig.type !== 'npc' || nextNodeConfig.npc_id !== currentNodeConfig.npc_id)
  ) {
    removeNpcForNode(currentNodeConfig);
  }

  setNodeConfig(nodeId, nextNodeConfig);
  syncDerivedCollections();
  renderAll();
}

function applyToolToNode(nodeId, forcedType = null) {
  const nextType = forcedType ?? state.activeTool;
  const currentNode = getNodeConfig(nodeId);
  state.selectedNodeId = nodeId;

  if (nextType === 'normal') {
    applyNodeUpdate(nodeId, { type: 'normal' });
    setStatus(`${nodeId} を normal に戻しました。`);
    return;
  }

  if (['wall', 'door', 'building_interior'].includes(nextType)) {
    const buildingId = state.activeBuildingId ?? currentNode.building_id ?? null;
    if (!buildingId) {
      setStatus('wall / door / building_interior を置く前に建物を選択または追加してください。');
      return;
    }

    applyNodeUpdate(nodeId, {
      type: nextType,
      label: currentNode.label,
      building_id: buildingId,
    });
    return;
  }

  if (nextType === 'npc') {
    const npcId = state.activeNpcId ?? currentNode.npc_id ?? null;
    if (!npcId) {
      setStatus('NPC を置く前に NPC を選択または追加してください。');
      return;
    }

    applyNodeUpdate(nodeId, {
      type: 'npc',
      label: currentNode.label,
      npc_id: npcId,
      ...(currentNode.building_id ? { building_id: currentNode.building_id } : {}),
    });
  }
}

function renderTilePalette() {
  elements.tilePalette.innerHTML = '';
  for (const nodeType of NODE_TYPES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tile-button${state.activeTool === nodeType ? ' active' : ''}`;
    button.style.setProperty('--tile-color', NODE_TYPE_COLORS[nodeType]);
    button.textContent = NODE_TYPE_LABELS[nodeType];
    button.addEventListener('click', () => {
      state.activeTool = nodeType;
      renderTilePalette();
    });
    elements.tilePalette.append(button);
  }
}

function renderEntitySelect(selectElement, values, selectedValue, getLabel) {
  selectElement.innerHTML = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = getLabel(value);
    option.selected = value === selectedValue;
    selectElement.append(option);
  }
}

function renderCanvas() {
  if (!state.config) {
    return;
  }

  elements.gridCanvas.width = state.config.map.cols * state.cellSize;
  elements.gridCanvas.height = state.config.map.rows * state.cellSize;
  const context = elements.gridCanvas.getContext('2d');
  context.clearRect(0, 0, elements.gridCanvas.width, elements.gridCanvas.height);
  context.font = '12px sans-serif';
  context.textBaseline = 'top';

  const spawnNodes = new Set(state.config.spawn.nodes);
  const selectedBuildingId = state.activeBuildingId;
  const selectedNpcId = state.activeNpcId;

  for (let row = 1; row <= state.config.map.rows; row += 1) {
    for (let col = 1; col <= state.config.map.cols; col += 1) {
      const nodeId = toNodeId(row, col);
      const nodeConfig = getNodeConfig(nodeId);
      const x = (col - 1) * state.cellSize;
      const y = (row - 1) * state.cellSize;

      context.fillStyle = NODE_TYPE_COLORS[nodeConfig.type] ?? NODE_TYPE_COLORS.normal;
      context.fillRect(x, y, state.cellSize, state.cellSize);

      if (spawnNodes.has(nodeId)) {
        context.fillStyle = 'rgba(16, 185, 129, 0.25)';
        context.fillRect(x, y, state.cellSize, state.cellSize);
      }

      if (nodeConfig.building_id && nodeConfig.building_id === selectedBuildingId) {
        context.strokeStyle = '#fbbf24';
        context.lineWidth = 3;
        context.strokeRect(x + 2, y + 2, state.cellSize - 4, state.cellSize - 4);
      }

      if (nodeConfig.npc_id && nodeConfig.npc_id === selectedNpcId) {
        context.strokeStyle = '#a78bfa';
        context.lineWidth = 3;
        context.strokeRect(x + 5, y + 5, state.cellSize - 10, state.cellSize - 10);
      }

      context.strokeStyle = '#0f172a';
      context.lineWidth = 1;
      context.strokeRect(x, y, state.cellSize, state.cellSize);

      if (state.selectedNodeId === nodeId) {
        context.strokeStyle = '#ffffff';
        context.lineWidth = 2;
        context.strokeRect(x + 1, y + 1, state.cellSize - 2, state.cellSize - 2);
      }

      context.fillStyle = '#f9fafb';
      context.fillText(nodeId, x + 4, y + 4);

      const label = nodeConfig.label ?? nodeConfig.building_id ?? nodeConfig.npc_id ?? '';
      if (label) {
        const shortLabel = label.length > 10 ? `${label.slice(0, 9)}…` : label;
        context.fillStyle = '#d1d5db';
        context.fillText(shortLabel, x + 4, y + state.cellSize - 18);
      }
    }
  }
}

function renderNodeInspector() {
  const selectedNodeId = state.selectedNodeId;
  elements.nodeTypeSelect.innerHTML = '';
  for (const nodeType of NODE_TYPES) {
    const option = document.createElement('option');
    option.value = nodeType;
    option.textContent = nodeType;
    elements.nodeTypeSelect.append(option);
  }

  const buildingOptions = [''].concat(state.config.map.buildings.map((building) => building.building_id));
  const npcOptions = [''].concat(state.config.map.npcs.map((npc) => npc.npc_id));

  elements.nodeBuildingSelect.innerHTML = '';
  for (const buildingId of buildingOptions) {
    const option = document.createElement('option');
    option.value = buildingId;
    option.textContent = buildingId || '(未設定)';
    elements.nodeBuildingSelect.append(option);
  }

  elements.nodeNpcSelect.innerHTML = '';
  for (const npcId of npcOptions) {
    const option = document.createElement('option');
    option.value = npcId;
    option.textContent = npcId || '(未設定)';
    elements.nodeNpcSelect.append(option);
  }

  if (!selectedNodeId) {
    elements.nodeIdInput.value = '';
    elements.nodeTypeSelect.value = 'normal';
    elements.nodeLabelInput.value = '';
    elements.nodeBuildingSelect.value = '';
    elements.nodeNpcSelect.value = '';
    elements.selectionSummary.textContent = 'ノードを選択してください。';
    return;
  }

  const nodeConfig = getNodeConfig(selectedNodeId);
  elements.nodeIdInput.value = selectedNodeId;
  elements.nodeTypeSelect.value = nodeConfig.type;
  elements.nodeLabelInput.value = nodeConfig.label ?? '';
  elements.nodeBuildingSelect.value = nodeConfig.building_id ?? '';
  elements.nodeNpcSelect.value = nodeConfig.npc_id ?? '';
  elements.selectionSummary.textContent = `${selectedNodeId} (${nodeConfig.type})`;
}

function renderBuildingInspector() {
  renderEntitySelect(
    elements.buildingSelect,
    state.config.map.buildings.map((building) => building.building_id),
    state.activeBuildingId,
    (buildingId) => buildingId,
  );

  const building = getSelectedBuilding();
  elements.buildingIdInput.value = building?.building_id ?? '';
  elements.buildingNameInput.value = building?.name ?? '';
  elements.buildingDescriptionInput.value = building?.description ?? '';
  elements.buildingWallNodes.textContent = building?.wall_nodes.join(', ') ?? '';
  elements.buildingInteriorNodes.textContent = building?.interior_nodes.join(', ') ?? '';
  elements.buildingDoorNodes.textContent = building?.door_nodes.join(', ') ?? '';

  elements.buildingActionsList.innerHTML = '';
  for (const [index, action] of (building?.actions ?? []).entries()) {
    const listItem = document.createElement('li');
    listItem.innerHTML = `
      <div class="item-row">
        <div>
          <strong>${action.action_id}</strong><br />
          <span>${action.name}</span><br />
          <small>${action.duration_ms}ms</small>
        </div>
        <div class="item-actions">
          <button type="button" data-kind="building-action" data-action="edit" data-index="${index}">編集</button>
          <button type="button" data-kind="building-action" data-action="delete" data-index="${index}">削除</button>
        </div>
      </div>
    `;
    elements.buildingActionsList.append(listItem);
  }
}

function renderNpcInspector() {
  renderEntitySelect(
    elements.npcSelect,
    state.config.map.npcs.map((npc) => npc.npc_id),
    state.activeNpcId,
    (npcId) => npcId,
  );

  const npc = getSelectedNpc();
  elements.npcIdInput.value = npc?.npc_id ?? '';
  elements.npcNameInput.value = npc?.name ?? '';
  elements.npcDescriptionInput.value = npc?.description ?? '';
  elements.npcNodeIdInput.value = npc?.node_id ?? '';

  elements.npcActionsList.innerHTML = '';
  for (const [index, action] of (npc?.actions ?? []).entries()) {
    const listItem = document.createElement('li');
    listItem.innerHTML = `
      <div class="item-row">
        <div>
          <strong>${action.action_id}</strong><br />
          <span>${action.name}</span><br />
          <small>${action.duration_ms}ms</small>
        </div>
        <div class="item-actions">
          <button type="button" data-kind="npc-action" data-action="edit" data-index="${index}">編集</button>
          <button type="button" data-kind="npc-action" data-action="delete" data-index="${index}">削除</button>
        </div>
      </div>
    `;
    elements.npcActionsList.append(listItem);
  }
}

function renderSettingsInspector() {
  elements.worldNameInput.value = state.config.world.name;
  elements.worldSkillNameInput.value = state.config.world.skill_name;
  elements.worldDescriptionInput.value = state.config.world.description;
  elements.mapRowsInput.value = String(state.config.map.rows);
  elements.mapColsInput.value = String(state.config.map.cols);
  elements.movementDurationInput.value = String(state.config.movement.duration_ms);
  elements.conversationMaxTurnsInput.value = String(state.config.conversation.max_turns);
  elements.conversationIntervalInput.value = String(state.config.conversation.interval_ms);
  elements.conversationAcceptTimeoutInput.value = String(state.config.conversation.accept_timeout_ms);
  elements.conversationTurnTimeoutInput.value = String(state.config.conversation.turn_timeout_ms);
  elements.perceptionRangeInput.value = String(state.config.perception.range);
  elements.spawnNodesInput.value = state.config.spawn.nodes.join(', ');
  elements.idleReminderEnabledInput.checked = Boolean(state.config.idle_reminder);
  elements.idleReminderIntervalInput.disabled = !state.config.idle_reminder;
  elements.idleReminderIntervalInput.value = state.config.idle_reminder?.interval_ms
    ? String(state.config.idle_reminder.interval_ms)
    : '';
}

function renderValidationResults() {
  elements.validationResults.innerHTML = '';
  for (const issue of state.validationIssues) {
    const listItem = document.createElement('li');
    listItem.className = issue.success ? 'success' : 'error';
    listItem.innerHTML = issue.success
      ? `<strong>OK</strong><br /><span>${issue.message}</span>`
      : `<strong>${issue.path}</strong><br /><span>${issue.message}</span>`;
    elements.validationResults.append(listItem);
  }
}

function renderAll() {
  if (!state.config) {
    return;
  }

  renderTilePalette();
  renderCanvas();
  renderNodeInspector();
  renderBuildingInspector();
  renderNpcInspector();
  renderSettingsInspector();
  renderValidationResults();
}

function createEmptyBuilding() {
  const existingIds = new Set(state.config.map.buildings.map((building) => building.building_id));
  const buildingId = generateUniqueId('building', existingIds);
  return {
    building_id: buildingId,
    name: buildingId,
    description: '',
    wall_nodes: [],
    interior_nodes: [],
    door_nodes: [],
    actions: [],
  };
}

function createEmptyNpc() {
  const existingIds = new Set(state.config.map.npcs.map((npc) => npc.npc_id));
  const npcId = generateUniqueId('npc', existingIds);
  return {
    npc_id: npcId,
    name: npcId,
    description: '',
    node_id: '',
    actions: [],
  };
}

function promptForAction(initialAction = null) {
  const actionId = prompt('アクションID', initialAction?.action_id ?? '');
  if (actionId === null) {
    return null;
  }

  const name = prompt('アクション名', initialAction?.name ?? '');
  if (name === null) {
    return null;
  }

  const description = prompt('アクション説明', initialAction?.description ?? '');
  if (description === null) {
    return null;
  }

  const durationText = prompt('所要時間(ms)', String(initialAction?.duration_ms ?? 1000));
  if (durationText === null) {
    return null;
  }

  return {
    action_id: actionId.trim(),
    name: name.trim(),
    description: description.trim(),
    duration_ms: Number.parseInt(durationText, 10) || 0,
  };
}

async function loadConfig() {
  setStatus('設定を読み込んでいます...');
  const response = await apiRequest('/api/admin/config');
  state.config = deepClone(response.config);
  state.selectedNodeId = null;
  state.activeBuildingId = state.config.map.buildings[0]?.building_id ?? null;
  state.activeNpcId = state.config.map.npcs[0]?.npc_id ?? null;
  syncDerivedCollections();
  clearValidationIssues();
  renderAll();
  setStatus(`設定を読み込みました。CONFIG_PATH の編集結果は保存後にサーバー再起動で反映されます。`);
}

async function validateConfigRemotely() {
  try {
    commitMapSizeInputs();
    setStatus('設定を検証しています...');
    await apiRequest('/api/admin/config/validate', {
      method: 'POST',
      body: JSON.stringify({ config: state.config }),
    });
    setValidationIssues([], 'バリデーションに成功しました。');
    setStatus('保存前チェックに成功しました。');
  } catch (error) {
    const details = Array.isArray(error.payload?.details) ? error.payload.details : [];
    setValidationIssues(details);
    setStatus('バリデーションエラーがあります。');
  }
}

async function saveConfig() {
  try {
    commitMapSizeInputs();
    setStatus('設定を保存しています...');
    await apiRequest('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ config: state.config }),
    });
    setValidationIssues([], '設定を保存しました。');
    setStatus('設定ファイルを更新しました。サーバー再起動後に反映されます。');
  } catch (error) {
    const details = Array.isArray(error.payload?.details) ? error.payload.details : [];
    setValidationIssues(details);
    setStatus('保存に失敗しました。バリデーション結果を確認してください。');
  }
}

function updateSelectedNode(mutator) {
  if (!state.selectedNodeId) {
    return;
  }

  const nodeConfig = { ...getNodeConfig(state.selectedNodeId) };
  mutator(nodeConfig);
  applyNodeUpdate(state.selectedNodeId, nodeConfig);
}

function bindEvents() {
  elements.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.adminKey = elements.adminKeyInput.value.trim();
    sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, state.adminKey);
    showApp();
    try {
      await loadConfig();
    } catch (error) {
      if (error.message !== 'Unauthorized') {
        showAuthDialog('設定の読み込みに失敗しました。管理キーとサーバー状態を確認してください。');
      }
    }
  });

  elements.reloadButton.addEventListener('click', () => {
    void loadConfig();
  });
  elements.validateButton.addEventListener('click', () => {
    void validateConfigRemotely();
  });
  elements.saveButton.addEventListener('click', () => {
    void saveConfig();
  });
  elements.clearValidationButton.addEventListener('click', clearValidationIssues);

  elements.cellSizeInput.addEventListener('input', () => {
    state.cellSize = Number.parseInt(elements.cellSizeInput.value, 10) || DEFAULT_CELL_SIZE;
    renderCanvas();
  });

  elements.gridCanvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
  elements.gridCanvas.addEventListener('pointerdown', (event) => {
    if (!state.config) {
      return;
    }

    const nodeId = getCanvasNodeId(event);
    if (!nodeId) {
      return;
    }

    state.selectedNodeId = nodeId;
    if (event.button === 2) {
      applyToolToNode(nodeId, 'normal');
      return;
    }

    state.isPainting = true;
    applyToolToNode(nodeId);
  });
  elements.gridCanvas.addEventListener('pointermove', (event) => {
    if (!state.isPainting || event.buttons === 0) {
      return;
    }

    const nodeId = getCanvasNodeId(event);
    if (!nodeId || nodeId === state.selectedNodeId) {
      return;
    }

    state.selectedNodeId = nodeId;
    applyToolToNode(nodeId);
  });
  window.addEventListener('pointerup', () => {
    state.isPainting = false;
  });

  elements.buildingSelect.addEventListener('change', () => {
    state.activeBuildingId = elements.buildingSelect.value || null;
    renderAll();
  });
  elements.npcSelect.addEventListener('change', () => {
    state.activeNpcId = elements.npcSelect.value || null;
    renderAll();
  });

  elements.addBuildingButton.addEventListener('click', () => {
    const building = createEmptyBuilding();
    state.config.map.buildings.push(building);
    state.activeBuildingId = building.building_id;
    renderAll();
  });
  elements.deleteBuildingButton.addEventListener('click', () => {
    const building = getSelectedBuilding();
    if (!building || !confirm(`${building.building_id} を削除しますか？ 建物ノードは normal に戻ります。`)) {
      return;
    }

    state.config.map.buildings = state.config.map.buildings.filter(
      (candidate) => candidate.building_id !== building.building_id,
    );
    for (const [nodeId, nodeConfig] of Object.entries(state.config.map.nodes)) {
      if (nodeConfig.building_id !== building.building_id) {
        continue;
      }

      if (nodeConfig.type === 'npc') {
        setNodeConfig(nodeId, {
          type: 'npc',
          label: nodeConfig.label,
          npc_id: nodeConfig.npc_id,
        });
      } else {
        setNodeConfig(nodeId, { type: 'normal' });
      }
    }

    syncDerivedCollections();
    renderAll();
  });

  elements.addNpcButton.addEventListener('click', () => {
    const npc = createEmptyNpc();
    state.config.map.npcs.push(npc);
    state.activeNpcId = npc.npc_id;
    renderAll();
  });
  elements.deleteNpcButton.addEventListener('click', () => {
    const npc = getSelectedNpc();
    if (!npc || !confirm(`${npc.npc_id} を削除しますか？ 配置ノードは normal に戻ります。`)) {
      return;
    }

    state.config.map.npcs = state.config.map.npcs.filter((candidate) => candidate.npc_id !== npc.npc_id);
    for (const [nodeId, nodeConfig] of Object.entries(state.config.map.nodes)) {
      if (nodeConfig.npc_id === npc.npc_id) {
        setNodeConfig(nodeId, { type: 'normal' });
      }
    }

    syncDerivedCollections();
    renderAll();
  });


  elements.addBuildingActionButton.addEventListener('click', () => {
    const building = getSelectedBuilding();
    if (!building) {
      return;
    }

    const action = promptForAction();
    if (!action) {
      return;
    }

    building.actions.push(action);
    renderBuildingInspector();
  });
  elements.addNpcActionButton.addEventListener('click', () => {
    const npc = getSelectedNpc();
    if (!npc) {
      return;
    }

    const action = promptForAction();
    if (!action) {
      return;
    }

    npc.actions.push(action);
    renderNpcInspector();
  });

  elements.buildingActionsList.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-kind="building-action"]');
    if (!target) {
      return;
    }

    const building = getSelectedBuilding();
    if (!building) {
      return;
    }

    const index = Number.parseInt(target.dataset.index ?? '', 10);
    if (target.dataset.action === 'delete') {
      building.actions.splice(index, 1);
    } else {
      const nextAction = promptForAction(building.actions[index]);
      if (!nextAction) {
        return;
      }
      building.actions[index] = nextAction;
    }
    renderBuildingInspector();
  });

  elements.npcActionsList.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-kind="npc-action"]');
    if (!target) {
      return;
    }

    const npc = getSelectedNpc();
    if (!npc) {
      return;
    }

    const index = Number.parseInt(target.dataset.index ?? '', 10);
    if (target.dataset.action === 'delete') {
      npc.actions.splice(index, 1);
    } else {
      const nextAction = promptForAction(npc.actions[index]);
      if (!nextAction) {
        return;
      }
      npc.actions[index] = nextAction;
    }
    renderNpcInspector();
  });


  elements.nodeTypeSelect.addEventListener('change', () => {
    if (!state.selectedNodeId) {
      return;
    }
    applyToolToNode(state.selectedNodeId, elements.nodeTypeSelect.value);
  });
  elements.nodeLabelInput.addEventListener('input', () => {
    updateSelectedNode((nodeConfig) => {
      nodeConfig.label = elements.nodeLabelInput.value.trim() || undefined;
    });
  });
  elements.nodeBuildingSelect.addEventListener('change', () => {
    updateSelectedNode((nodeConfig) => {
      nodeConfig.building_id = elements.nodeBuildingSelect.value || undefined;
    });
  });
  elements.nodeNpcSelect.addEventListener('change', () => {
    updateSelectedNode((nodeConfig) => {
      nodeConfig.npc_id = elements.nodeNpcSelect.value || undefined;
      if (nodeConfig.npc_id) {
        nodeConfig.type = 'npc';
      }
    });
  });

  elements.buildingIdInput.addEventListener('input', () => {
    const building = getSelectedBuilding();
    if (!building) {
      return;
    }

    const previousId = building.building_id;
    const nextId = elements.buildingIdInput.value.trim();
    building.building_id = nextId;
    for (const nodeConfig of Object.values(state.config.map.nodes)) {
      if (nodeConfig.building_id === previousId) {
        nodeConfig.building_id = nextId;
      }
    }
    if (state.activeBuildingId === previousId) {
      state.activeBuildingId = nextId;
    }
    syncDerivedCollections();
    renderAll();
  });
  elements.buildingNameInput.addEventListener('input', () => {
    const building = getSelectedBuilding();
    if (building) {
      building.name = elements.buildingNameInput.value;
    }
  });
  elements.buildingDescriptionInput.addEventListener('input', () => {
    const building = getSelectedBuilding();
    if (building) {
      building.description = elements.buildingDescriptionInput.value;
    }
  });

  elements.npcIdInput.addEventListener('input', () => {
    const npc = getSelectedNpc();
    if (!npc) {
      return;
    }

    const previousId = npc.npc_id;
    const nextId = elements.npcIdInput.value.trim();
    npc.npc_id = nextId;
    for (const nodeConfig of Object.values(state.config.map.nodes)) {
      if (nodeConfig.npc_id === previousId) {
        nodeConfig.npc_id = nextId;
      }
    }
    if (state.activeNpcId === previousId) {
      state.activeNpcId = nextId;
    }
    syncDerivedCollections();
    renderAll();
  });
  elements.npcNameInput.addEventListener('input', () => {
    const npc = getSelectedNpc();
    if (npc) {
      npc.name = elements.npcNameInput.value;
    }
  });
  elements.npcDescriptionInput.addEventListener('input', () => {
    const npc = getSelectedNpc();
    if (npc) {
      npc.description = elements.npcDescriptionInput.value;
    }
  });

  elements.worldNameInput.addEventListener('input', () => {
    state.config.world.name = elements.worldNameInput.value;
  });
  elements.worldSkillNameInput.addEventListener('input', () => {
    state.config.world.skill_name = elements.worldSkillNameInput.value;
  });
  elements.worldDescriptionInput.addEventListener('input', () => {
    state.config.world.description = elements.worldDescriptionInput.value;
  });
  elements.mapRowsInput.addEventListener('change', () => {
    commitMapSizeInputs();
    renderAll();
  });
  elements.mapColsInput.addEventListener('change', () => {
    commitMapSizeInputs();
    renderAll();
  });
  elements.movementDurationInput.addEventListener('input', () => {
    state.config.movement.duration_ms = Number.parseInt(elements.movementDurationInput.value, 10) || 0;
  });
  elements.conversationMaxTurnsInput.addEventListener('input', () => {
    state.config.conversation.max_turns = Number.parseInt(elements.conversationMaxTurnsInput.value, 10) || 0;
  });
  elements.conversationIntervalInput.addEventListener('input', () => {
    state.config.conversation.interval_ms = Number.parseInt(elements.conversationIntervalInput.value, 10) || 0;
  });
  elements.conversationAcceptTimeoutInput.addEventListener('input', () => {
    state.config.conversation.accept_timeout_ms = Number.parseInt(elements.conversationAcceptTimeoutInput.value, 10) || 0;
  });
  elements.conversationTurnTimeoutInput.addEventListener('input', () => {
    state.config.conversation.turn_timeout_ms = Number.parseInt(elements.conversationTurnTimeoutInput.value, 10) || 0;
  });
  elements.perceptionRangeInput.addEventListener('input', () => {
    state.config.perception.range = Number.parseInt(elements.perceptionRangeInput.value, 10) || 0;
  });
  elements.spawnNodesInput.addEventListener('change', () => {
    state.config.spawn.nodes = elements.spawnNodesInput.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  });
  elements.idleReminderEnabledInput.addEventListener('change', () => {
    state.config.idle_reminder = elements.idleReminderEnabledInput.checked
      ? { interval_ms: parsePositiveInteger(elements.idleReminderIntervalInput.value, 60000) }
      : undefined;
    if (state.config.idle_reminder) {
      elements.idleReminderIntervalInput.value = String(state.config.idle_reminder.interval_ms);
    }
    elements.idleReminderIntervalInput.disabled = !elements.idleReminderEnabledInput.checked;
  });
  elements.idleReminderIntervalInput.addEventListener('input', () => {
    if (!elements.idleReminderEnabledInput.checked || !state.config.idle_reminder) {
      return;
    }
    state.config.idle_reminder.interval_ms = Number.parseInt(elements.idleReminderIntervalInput.value, 10) || 0;
  });

}

bindEvents();
renderTilePalette();

if (state.adminKey) {
  showApp();
  void loadConfig().catch(() => {
    showAuthDialog('管理キーが無効か、設定の読み込みに失敗しました。');
  });
} else {
  showAuthDialog('管理キーを入力してください。');
}
