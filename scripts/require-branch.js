// Build-branch guard: refuses an EAS build unless you're on the expected branch.
// Enforces dev→dev, staging→staging, production→main so a prod app can never be
// built from staging/dev by accident. Used by the build:* npm scripts.
const { execSync } = require('child_process');

const want = process.argv[2];
if (!want) {
    console.error('require-branch: missing expected branch argument');
    process.exit(1);
}

let cur;
try {
    cur = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
    console.error('require-branch: not a git repository?');
    process.exit(1);
}

if (cur !== want) {
    console.error('');
    console.error(`🚫 This build must run from '${want}', but you're on '${cur}'.`);
    console.error(`   Switch first:  git switch ${want}`);
    console.error('');
    process.exit(1);
}

// Warn (don't block) on a dirty tree — EAS uploads the working dir, so uncommitted
// changes would ship. Helpful nudge before a real build.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (dirty) {
    console.warn(`⚠️  Working tree has uncommitted changes — they'll be in this build:`);
    console.warn(dirty.split('\n').map((l) => '   ' + l).join('\n'));
}

console.log(`✓ on '${want}' — building`);
