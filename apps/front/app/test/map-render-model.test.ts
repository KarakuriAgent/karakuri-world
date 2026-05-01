import { describe, expect, it } from 'vitest';

import type { SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';
import {
  buildMapRenderModel,
  getBuildingPaletteColor,
  getNodeCenter,
  getNodeFillColor,
  getNodeLayout,
  getNodeTextColor,
} from '../components/map/map-render-model.js';

function createMapRenderSnapshot(): SpectatorSnapshot {
  return {
    schema_version: 1,
    world: {
      name: 'Karakuri World',
      description: 'Grid and label fixture',
    },
    timezone: 'Asia/Tokyo',
    calendar: {
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-20',
      local_time: '18:30:00',
      display_label: '2026-06-20 18:30 (Asia/Tokyo)',
    },
    map: {
      rows: 2,
      cols: 2,
      nodes: {
        '1-1': { type: 'wall', label: 'Wall' },
        '1-2': { type: 'building_interior', building_id: 'atelier' },
        '2-1': { type: 'npc', npc_id: 'keeper', label: 'Keeper' },
        '2-2': { type: 'normal' },
      },
      buildings: [
        {
          building_id: 'atelier',
          name: 'Atelier',
          description: 'Creative workshop',
          wall_nodes: ['1-1'],
          interior_nodes: ['1-2'],
          door_nodes: [],
        },
      ],
      npcs: [
        {
          npc_id: 'keeper',
          name: 'Keeper',
          description: 'Watches the square',
          node_id: '2-1',
        },
      ],
    },
    map_render_theme: {
      cell_size: 64,
      label_font_size: 14,
      node_id_font_size: 12,
      background_fill: '#101010',
      grid_stroke: '#202020',
      default_node_fill: '#303030',
      normal_node_fill: '#404040',
      wall_node_fill: '#505050',
      door_node_fill: '#606060',
      npc_node_fill: '#707070',
      building_palette: ['#808080', '#909090', '#a0a0a0'],
      wall_text_color: '#f5f5f5',
      default_text_color: '#111111',
    },
    agents: [],
    known_agents: [],
    conversations: [],
    recent_server_announcements: [],
    generated_at: 1_780_000_000_000,
    published_at: 1_780_000_005_000,
  };
}

describe('map render model', () => {
  it('creates a stable grid and label render snapshot from map + theme only', () => {
    expect(buildMapRenderModel(createMapRenderSnapshot())).toMatchInlineSnapshot(`
      {
        "backgroundFill": "#101010",
        "cells": [
          {
            "centerLabel": {
              "anchor": 0.5,
              "color": "#f5f5f5",
              "fontSize": 14,
              "text": "Wall",
              "x": 32,
              "y": 32,
            },
            "centerX": 32,
            "centerY": 32,
            "col": 1,
            "fill": "#505050",
            "nodeId": "1-1",
            "nodeIdLabel": {
              "color": "#f5f5f5",
              "fontSize": 12,
              "text": "1-1",
              "x": 8,
              "y": 6,
            },
            "row": 1,
            "size": 64,
            "stroke": "#202020",
            "textColor": "#f5f5f5",
            "x": 0,
            "y": 0,
          },
          {
            "centerX": 96,
            "centerY": 32,
            "col": 2,
            "fill": "#a0a0a0",
            "nodeId": "1-2",
            "nodeIdLabel": {
              "color": "#111111",
              "fontSize": 12,
              "text": "1-2",
              "x": 72,
              "y": 6,
            },
            "row": 1,
            "size": 64,
            "stroke": "#202020",
            "textColor": "#111111",
            "x": 64,
            "y": 0,
          },
          {
            "centerLabel": {
              "anchor": 0.5,
              "color": "#111111",
              "fontSize": 14,
              "text": "Keeper",
              "x": 32,
              "y": 96,
            },
            "centerX": 32,
            "centerY": 96,
            "col": 1,
            "fill": "#707070",
            "nodeId": "2-1",
            "nodeIdLabel": {
              "color": "#111111",
              "fontSize": 12,
              "text": "2-1",
              "x": 8,
              "y": 70,
            },
            "row": 2,
            "size": 64,
            "stroke": "#202020",
            "textColor": "#111111",
            "x": 0,
            "y": 64,
          },
          {
            "centerX": 96,
            "centerY": 96,
            "col": 2,
            "fill": "#404040",
            "nodeId": "2-2",
            "nodeIdLabel": {
              "color": "#111111",
              "fontSize": 12,
              "text": "2-2",
              "x": 72,
              "y": 70,
            },
            "row": 2,
            "size": 64,
            "stroke": "#202020",
            "textColor": "#111111",
            "x": 64,
            "y": 64,
          },
        ],
        "height": 128,
        "width": 128,
      }
    `);
  });

  it('maps theme colors to normal, wall, door, building, npc, and fallback cells', () => {
    const snapshot = createMapRenderSnapshot();
    const { map_render_theme: theme } = snapshot;

    expect(getNodeFillColor(theme, undefined)).toBe('#303030');
    expect(getNodeFillColor(theme, { type: 'normal' })).toBe('#404040');
    expect(getNodeFillColor(theme, { type: 'wall' })).toBe('#505050');
    expect(getNodeFillColor(theme, { type: 'door' })).toBe('#606060');
    expect(getNodeFillColor(theme, { type: 'building_interior', building_id: 'atelier' })).toBe('#a0a0a0');
    expect(getNodeFillColor(theme, { type: 'npc' })).toBe('#707070');
    expect(getNodeFillColor(theme, { type: 'normal', npc_id: 'keeper' })).toBe('#404040');
    expect(getBuildingPaletteColor(theme, 'atelier')).toBe('#a0a0a0');
    expect(getNodeTextColor(theme, { type: 'wall' })).toBe('#f5f5f5');
    expect(getNodeTextColor(theme, { type: 'normal' })).toBe('#111111');
  });

  it('translates grid coordinates into cell, node-id, and center-label positions', () => {
    const snapshot = createMapRenderSnapshot();
    const renderModel = buildMapRenderModel(snapshot);

    expect(getNodeLayout(snapshot, '2-2')).toEqual({
      nodeId: '2-2',
      row: 2,
      col: 2,
      size: 64,
      x: 64,
      y: 64,
      centerX: 96,
      centerY: 96,
    });
    expect(getNodeCenter(snapshot, '2-2')).toEqual({
      centerX: 96,
      centerY: 96,
    });
    expect(getNodeLayout(snapshot, '3-1')).toBeUndefined();
    expect(getNodeCenter(snapshot, 'not-a-node')).toBeUndefined();
    expect(renderModel.cells[0]).toMatchObject({
      nodeIdLabel: {
        x: 8,
        y: 6,
      },
      centerLabel: {
        anchor: 0.5,
        x: 32,
        y: 32,
      },
    });
  });

  it('converts Discord baseline-style node-id offsets into Pixi top-left text coordinates', () => {
    const snapshot = createMapRenderSnapshot();
    const renderModel = buildMapRenderModel(snapshot);

    expect(renderModel.cells[0]?.nodeIdLabel).toMatchObject({
      fontSize: 12,
      y: 18 - 12,
    });
    expect(renderModel.cells[2]?.nodeIdLabel).toMatchObject({
      fontSize: 12,
      y: 64 + 18 - 12,
    });
  });
});
