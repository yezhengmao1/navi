import test from 'node:test';
import assert from 'node:assert/strict';
import { routeReview, decodeEvidence } from '../lib/routing.mjs';

test('explicit code/paper requests route, ambiguity and negation do not', () => {
  assert.deepEqual(routeReview('用 team review 最新 commit'), { kind: 'code', team: true });
  assert.deepEqual(routeReview('审一下 main.tex'), { kind: 'paper', team: false });
  assert.equal(routeReview('review code and paper'), null);
  assert.equal(routeReview('不要 review commit'), null);
  assert.equal(routeReview('/magic-review code'), null);
  assert.equal(routeReview('Implement ONLY paper review assets and code tests'), null);
  assert.equal(routeReview('开发论文审查插件'), null);
  assert.equal(routeReview('Do not edit.\nReview paper later.'), null);
  assert.equal(routeReview('[magic-review routed]\nreview commit'), null);
});

test('chunked evidence decodes nested data without loss', () => {
  assert.deepEqual(decodeEvidence('{"x":{"encoding":"concatenate-chunks","chunks":["a","b"]}}'), { x: 'ab' });
});
