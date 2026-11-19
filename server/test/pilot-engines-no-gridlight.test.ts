/**
 * The feature pipeline's staffing step offers the engines in PILOT_ENGINES — Gridlight is no longer
 * one of them (REQUESTED: "remove the gridlight option in the choices of AI to connect to").
 * Its label stays, so a stage that already ran on Gridlight still reads correctly.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_ENGINES, ENGINE_LABEL } from '../src/lib/goal-pilot-runner.ts';

test('the pipeline offers Claude and Codex, not Gridlight', () => {
  assert.deepEqual([...PILOT_ENGINES], ['claude', 'codex']);
  assert.equal(ENGINE_LABEL.gridlight, 'Gridlight', 'old stages on Gridlight must still be labelled');
});
