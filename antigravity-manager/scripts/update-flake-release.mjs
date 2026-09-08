import fs from 'node:fs';
import path from 'node:path';

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_FLAKE_PATH = 'flake.nix';
const SOURCE_CONFIGS = [
  {
    system: 'x86_64-linux',
    checksumArg: 'amd64-checksums',
    debArch: 'amd64',
  },
  {
    system: 'aarch64-linux',
    checksumArg: 'arm64-checksums',
    debArch: 'arm64',
  },
];

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];
    if (!rawArg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${rawArg}`);
    }

    const key = rawArg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function normalizeVersion(value) {
  const version = value?.trim().replace(/^v/, '');
  if (!version) {
    throw new Error('Version is required');
  }

  return version;
}

function readChecksum(checksumPath, artifactName) {
  const checksumText = fs.readFileSync(checksumPath, 'utf8');
  const line = checksumText
    .split(/\r?\n/)
    .find((entry) => entry.trimEnd().endsWith(`  ${artifactName}`));

  if (!line) {
    throw new Error(`Could not find ${artifactName} in ${checksumPath}`);
  }

  const [hash] = line.trim().split(/\s+/);
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid sha256 for ${artifactName}: ${hash}`);
  }

  return hash.toLowerCase();
}

function replaceVersion(flakeText, version) {
  return flakeText.replace(/version = "[^"]+";/, `version = "${version}";`);
}

function replaceSourceHash(flakeText, system, sha256) {
  const sourcePattern = new RegExp(
    `("${system}" = \\{[\\s\\S]*?sha256 = ")[a-f0-9]+(";[\\s\\S]*?\\};)`,
    'i',
  );

  if (!sourcePattern.test(flakeText)) {
    throw new Error(`Could not find sha256 source block for ${system}`);
  }

  return flakeText.replace(sourcePattern, `$1${sha256}$2`);
}

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version);
const flakePath = path.resolve(args.flake ?? DEFAULT_FLAKE_PATH);

let flakeText = fs.readFileSync(flakePath, 'utf8');
flakeText = replaceVersion(flakeText, version);

for (const sourceConfig of SOURCE_CONFIGS) {
  const checksumPath = args[sourceConfig.checksumArg];
  if (!checksumPath) {
    throw new Error(`Missing --${sourceConfig.checksumArg}`);
  }

  const artifactName = `Antigravity.Manager_${version}_${sourceConfig.debArch}.deb`;
  const sha256 = readChecksum(checksumPath, artifactName);
  flakeText = replaceSourceHash(flakeText, sourceConfig.system, sha256);
  console.log(`${sourceConfig.system}: ${artifactName} ${sha256}`);
}

fs.writeFileSync(flakePath, flakeText);
console.log(`Updated ${path.relative(process.cwd(), flakePath)} to ${version}`);
