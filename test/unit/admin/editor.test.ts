import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import type { NodeConfig, ServerConfig } from '../../../src/types/data-model.js';
import { createTestConfig } from '../../helpers/test-map.js';

type FakeEvent = {
  button: number;
  clientX: number;
  clientY: number;
  currentTarget: FakeElement;
  preventDefault: () => void;
  target: FakeElement;
};

class FakeClassList {
  #classes = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.#classes.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.#classes.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.#classes.has(token);
  }
}

class FakeStyle {
  setProperty(_name: string, _value: string): void {}
}

class FakeCanvasContext {
  fillStyle = '';
  font = '';
  lineWidth = 1;
  strokeStyle = '';
  textBaseline = '';

  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  strokeRect(): void {}
}

class FakeElement {
  checked = false;
  children: FakeElement[] = [];
  classList = new FakeClassList();
  className = '';
  dataset: Record<string, string> = {};
  disabled = false;
  height = 600;
  #innerHtml = '';
  #listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  style = new FakeStyle();
  #textContent = '';
  value = '';
  width = 800;

  constructor(readonly id: string) {}

  set innerHTML(value: string) {
    this.#innerHtml = value;
    this.children = [];
  }

  get innerHTML(): string {
    return this.#innerHtml;
  }

  set textContent(value: string) {
    this.#textContent = value;
  }

  get textContent(): string {
    return this.#textContent;
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const handlers = this.#listeners.get(type) ?? [];
    handlers.push(handler);
    this.#listeners.set(type, handlers);
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        this.children.push(node);
      }
    }
  }

  appendChild(node: unknown): void {
    this.append(node);
  }

  dispatch(type: string, extra: Partial<FakeEvent> = {}): void {
    const handlers = this.#listeners.get(type) ?? [];
    const event: FakeEvent = {
      button: 0,
      clientX: 0,
      clientY: 0,
      currentTarget: this,
      preventDefault() {},
      target: this,
      ...extra,
    };
    for (const handler of handlers) {
      handler(event);
    }
  }

  focus(): void {}

  getBoundingClientRect(): { height: number; left: number; top: number; width: number } {
    return {
      width: this.width,
      height: this.height,
      left: 0,
      top: 0,
    };
  }

  getContext(_kind: string): FakeCanvasContext {
    return new FakeCanvasContext();
  }
}

type EditorHooks = {
  applyNodeUpdate: (nodeId: string, nextNodeConfig: NodeConfig) => void;
  elements: {
    idleReminderEnabledInput: FakeElement;
    idleReminderIntervalInput: FakeElement;
    mapColsInput: FakeElement;
    mapRowsInput: FakeElement;
  };
  renderSettingsInspector: () => void;
  state: {
    activeBuildingId: string | null;
    activeNpcId: string | null;
    config: ServerConfig | null;
    selectedEventId: string | null;
  };
};

function loadEditorRuntime(): EditorHooks {
  const domElements = new Map<string, FakeElement>();
  const sessionStorageData = new Map<string, string>();
  const document = {
    createElement(tagName: string) {
      return new FakeElement(tagName);
    },
    querySelector(selector: string) {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      const existingElement = domElements.get(id);
      if (existingElement) {
        return existingElement;
      }

      const nextElement = new FakeElement(id);
      domElements.set(id, nextElement);
      return nextElement;
    },
  };

  const context = vm.createContext({
    confirm: () => true,
    console,
    document,
    fetch: async () => {
      throw new Error('Unexpected fetch call in editor test.');
    },
    prompt: () => null,
    sessionStorage: {
      getItem(key: string) {
        return sessionStorageData.get(key) ?? null;
      },
      removeItem(key: string) {
        sessionStorageData.delete(key);
      },
      setItem(key: string, value: string) {
        sessionStorageData.set(key, value);
      },
    },
    structuredClone,
    window: {
      addEventListener() {},
    },
  });

  const editorSource = readFileSync(
    resolve('/mnt/0AB07FFEB07FEF17/workspace/karakuri-world', 'src/admin/editor/editor.js'),
    'utf8',
  );
  vm.runInContext(
    `${editorSource}\n;globalThis.__editorTestHooks = { state, elements, applyNodeUpdate, renderSettingsInspector };`,
    context,
    { filename: 'editor.js' },
  );

  return (context as { __editorTestHooks: EditorHooks }).__editorTestHooks;
}

function initializeConfig(hooks: EditorHooks, config: ServerConfig): void {
  hooks.state.config = config;
  hooks.state.activeBuildingId = config.map.buildings[0]?.building_id ?? null;
  hooks.state.activeNpcId = config.map.npcs[0]?.npc_id ?? null;
  hooks.state.selectedEventId = config.server_events[0]?.event_id ?? null;
}

describe('admin editor', () => {
  it('delays node pruning until map size changes are committed', () => {
    const hooks = loadEditorRuntime();
    const config = createTestConfig();
    config.map.rows = 10;
    config.map.nodes['10-1'] = { type: 'wall', building_id: 'building-workshop' };
    initializeConfig(hooks, config);

    hooks.elements.mapRowsInput.value = '2';
    hooks.elements.mapRowsInput.dispatch('input');
    expect(config.map.nodes['10-1']).toEqual({ type: 'wall', building_id: 'building-workshop' });

    hooks.elements.mapRowsInput.dispatch('change');
    expect(config.map.rows).toBe(2);
    expect(config.map.nodes['10-1']).toBeUndefined();
  });

  it('moves an existing NPC instead of leaving duplicate placements behind', () => {
    const hooks = loadEditorRuntime();
    const config = createTestConfig();
    delete config.map.nodes['1-2'];
    config.map.nodes['2-4'] = {
      type: 'npc',
      label: 'Workshop Keeper',
      building_id: 'building-workshop',
      npc_id: 'npc-gatekeeper',
    };
    config.map.npcs[0].node_id = '2-4';
    initializeConfig(hooks, config);

    hooks.applyNodeUpdate('1-1', { type: 'npc', npc_id: 'npc-gatekeeper' });

    expect(config.map.nodes['1-1']).toEqual({ type: 'npc', npc_id: 'npc-gatekeeper' });
    expect(config.map.nodes['2-4']).toEqual({
      type: 'building_interior',
      label: 'Workshop Keeper',
      building_id: 'building-workshop',
    });
    expect(config.map.npcs[0]?.node_id).toBe('1-1');
  });

  it('ignores idle reminder interval edits while the feature is disabled', () => {
    const hooks = loadEditorRuntime();
    const config = createTestConfig();
    initializeConfig(hooks, config);
    hooks.renderSettingsInspector();

    expect(hooks.elements.idleReminderIntervalInput.disabled).toBe(true);

    hooks.elements.idleReminderIntervalInput.value = '120000';
    hooks.elements.idleReminderIntervalInput.dispatch('input');
    expect(config.idle_reminder).toBeUndefined();

    hooks.elements.idleReminderEnabledInput.checked = true;
    hooks.elements.idleReminderEnabledInput.dispatch('change');
    expect(config.idle_reminder).toEqual({ interval_ms: 120000 });
    expect(hooks.elements.idleReminderIntervalInput.disabled).toBe(false);
  });
});
