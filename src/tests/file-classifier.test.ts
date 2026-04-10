import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile, isASTAnalyzable, groupByCategory } from '../core/file-classifier.js';
import type { FileInfo } from '../scanner/file-walker.js';

function makeFile(relativePath: string): FileInfo {
  const ext = '.' + relativePath.split('.').pop()!;
  return { path: `/root/${relativePath}`, relativePath, content: '', extension: ext };
}

describe('File Classifier', () => {
  describe('classifyFile', () => {
    it('should classify TypeScript as code_js', () => {
      assert.equal(classifyFile(makeFile('app.ts')), 'code_js');
      assert.equal(classifyFile(makeFile('app.tsx')), 'code_js');
    });

    it('should classify JavaScript as code_js', () => {
      assert.equal(classifyFile(makeFile('app.js')), 'code_js');
      assert.equal(classifyFile(makeFile('app.jsx')), 'code_js');
      assert.equal(classifyFile(makeFile('app.mjs')), 'code_js');
      assert.equal(classifyFile(makeFile('app.cjs')), 'code_js');
    });

    it('should classify Python as code_python', () => {
      assert.equal(classifyFile(makeFile('app.py')), 'code_python');
    });

    it('should classify Shell as code_shell', () => {
      assert.equal(classifyFile(makeFile('setup.sh')), 'code_shell');
      assert.equal(classifyFile(makeFile('build.bash')), 'code_shell');
    });

    it('should classify config files', () => {
      assert.equal(classifyFile(makeFile('config.json')), 'config');
      assert.equal(classifyFile(makeFile('config.yaml')), 'config');
      assert.equal(classifyFile(makeFile('config.yml')), 'config');
      assert.equal(classifyFile(makeFile('config.toml')), 'config');
    });

    it('should classify Markdown', () => {
      assert.equal(classifyFile(makeFile('README.md')), 'markdown');
    });

    it('should classify Solidity', () => {
      assert.equal(classifyFile(makeFile('contract.sol')), 'solidity');
    });

    it('should classify unknown extensions as other', () => {
      assert.equal(classifyFile(makeFile('data.csv')), 'other');
      assert.equal(classifyFile(makeFile('image.png')), 'other');
    });
  });

  describe('isASTAnalyzable', () => {
    it('should return true for JS/TS files', () => {
      assert.ok(isASTAnalyzable(makeFile('app.ts')));
      assert.ok(isASTAnalyzable(makeFile('app.js')));
      assert.ok(isASTAnalyzable(makeFile('app.tsx')));
    });

    it('should return false for non-JS files', () => {
      assert.ok(!isASTAnalyzable(makeFile('app.py')));
      assert.ok(!isASTAnalyzable(makeFile('README.md')));
      assert.ok(!isASTAnalyzable(makeFile('config.json')));
    });
  });

  describe('groupByCategory', () => {
    it('should group files by category', () => {
      const files = [
        makeFile('app.ts'),
        makeFile('util.js'),
        makeFile('config.json'),
        makeFile('README.md'),
      ];
      const groups = groupByCategory(files);
      assert.equal(groups.get('code_js')?.length, 2);
      assert.equal(groups.get('config')?.length, 1);
      assert.equal(groups.get('markdown')?.length, 1);
    });
  });
});
