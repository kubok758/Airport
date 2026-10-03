'use strict';
// All game scripts share one global scope. A repeated top-level function silently replaces the earlier one,
// so every top-level function name must be unique across files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'js');

test('top-level function names are unique across scripts', () => {
  const seen = new Map(), clashes = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const [, name] of src.matchAll(/^(?:async\s+)?function\s+([\w$]+)/gm)) {
      if (seen.has(name)) clashes.push(name + ' in ' + seen.get(name) + ' and ' + file);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(clashes, []);
});

test('index.html loads every script once, in dependency order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="js\/([\w-]+\.js)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['data.js', 'state.js', 'sim.js', 'storage.js', 'models.js', 'render.js', 'ui.js', 'input.js', 'main.js']);
  assert.deepEqual(scripts.slice().sort(), fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort());
});
