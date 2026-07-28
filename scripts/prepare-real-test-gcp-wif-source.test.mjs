import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HELPER = join(SCRIPT_DIRECTORY, "prepare-real-test-gcp-wif-source.py");
const VERIFIER = join(SCRIPT_DIRECTORY, "verify-gcp-wif-bundle.mjs");
const VERSION = "20260728T062225Z";
const CERT_NAME = `leaf-${VERSION}.cert.pem`;
const KEY_NAME = `leaf-${VERSION}.key.pem`;
const SOURCE = "root/xingheng-real-test-wif-source";
const AUDIENCE_FILE = "root/xingheng-real-test-wif-audience";
const AUDIENCE = "//iam.googleapis.com/projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509";
const HOST_OPENSSL = "/usr/bin/openssl";
const COMPONENTS = {
  "Google Cloud SDK": "576.0.0",
  alpha: "2026.07.10",
  beta: "2026.07.10",
  bq: "2.1.34",
  "bundled-python3-unix": "3.14.6",
  core: "2026.07.10",
  "gcloud-crc32c": "1.0.0",
  gsutil: "5.37",
  preview: "2026.07.10",
};

const PYTHON_HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location("prepare_real_test_wif", os.environ["HELPER"])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

root = os.environ["FIXTURE_ROOT"]
stage_actual = os.path.join(root, module.STAGE.lstrip("/"))
key_actual = os.path.join(stage_actual, module.KEY_NAME)
cert_actual = os.path.join(stage_actual, module.CERT_NAME)
stage_stat = os.lstat(stage_actual)
key_stat = os.lstat(key_actual)
cert_stat = os.lstat(cert_actual)

def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

def frozen(path, sha_override=None):
    metadata = os.lstat(path)
    return module.FrozenFile(
        dev=metadata.st_dev,
        ino=metadata.st_ino,
        size=metadata.st_size,
        sha256=sha_override or sha(path),
        mode=stat.S_IMODE(metadata.st_mode),
        nlink=metadata.st_nlink,
    )

openssl = "/usr/bin/openssl"
public_der = subprocess.check_output(
    [openssl, "pkey", "-in", key_actual, "-pubout", "-outform", "DER"]
)
list_path = os.path.join(root, "var/lib/dpkg/info/google-cloud-cli.list")
md5_path = os.path.join(root, "var/lib/dpkg/info/google-cloud-cli.md5sums")
list_content = open(list_path, "rb").read()
md5_content = open(md5_path, "rb").read()
gcloud_actual = os.path.join(root, "usr/lib/google-cloud-sdk/bin/gcloud")
dash_actual = os.path.join(root, "usr/bin/dash")
python_actual = os.path.join(
    root, "usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3"
)
config = module.PrepareConfig(
    filesystem_root=root,
    gcloud_path="/usr/lib/google-cloud-sdk/bin/gcloud",
    dash_path="/usr/bin/dash",
    bundled_python_path="/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3",
    sdk_root="/usr/lib/google-cloud-sdk",
    pycache_path="/root/.xingheng-real-test-gcloud-pycache-d2b1",
    gcloud_config_path="/root/.xingheng-real-test-gcloud-config-d2b1",
    dpkg_query_path="/usr/bin/dpkg-query",
    dpkg_path="/usr/bin/dpkg",
    package_list_path="/var/lib/dpkg/info/google-cloud-cli.list",
    package_md5sums_path="/var/lib/dpkg/info/google-cloud-cli.md5sums",
    gcloud_uid=os.geteuid(),
    gcloud=frozen(gcloud_actual, os.environ.get("GCLOUD_SHA_OVERRIDE")),
    dash=frozen(dash_actual, os.environ.get("DASH_SHA_OVERRIDE")),
    bundled_python=frozen(python_actual, os.environ.get("PYTHON_SHA_OVERRIDE")),
    gcloud_package=os.environ.get(
        "GCLOUD_PACKAGE_OVERRIDE",
        "google-cloud-cli|576.0.0-test|fixture|ii",
    ),
    dash_package=os.environ.get("DASH_PACKAGE_OVERRIDE", "dash|0.5.12-test|fixture|ii"),
    package_list_lines=len(list_content.splitlines()),
    package_list_sha256=os.environ.get(
        "LIST_SHA_OVERRIDE", hashlib.sha256(list_content).hexdigest()
    ),
    package_md5sums_lines=len(md5_content.splitlines()),
    package_md5sums_sha256=os.environ.get(
        "MD5_SHA_OVERRIDE", hashlib.sha256(md5_content).hexdigest()
    ),
    python_version=os.environ["FIXTURE_PYTHON_VERSION"],
    sdk_probe_module="googlecloudsdk.core.config",
    gcloud_components=module.GCLOUD_COMPONENTS,
    openssl_path="/usr/bin/openssl",
    openssl_uid=os.lstat(os.path.join(root, "usr/bin/openssl")).st_uid,
    owner_uid=os.geteuid(),
    owner_gid=os.getegid(),
    stage=module.STAGE,
    source=module.SOURCE,
    audience_file=module.AUDIENCE_FILE,
    key_name=module.KEY_NAME,
    cert_name=module.CERT_NAME,
    stage_dev=stage_stat.st_dev,
    stage_ino=stage_stat.st_ino,
    key=module.FrozenFile(
        dev=key_stat.st_dev,
        ino=key_stat.st_ino + int(os.environ.get("KEY_INO_OFFSET", "0")),
        size=key_stat.st_size,
        sha256=os.environ.get("KEY_SHA_OVERRIDE", sha(key_actual)),
    ),
    cert=module.FrozenFile(
        dev=cert_stat.st_dev,
        ino=cert_stat.st_ino,
        size=cert_stat.st_size,
        sha256=sha(cert_actual),
    ),
    public_key_sha256=hashlib.sha256(public_der).hexdigest(),
)

rename_mode = os.environ.get("RENAME_MODE", "success")

def publish(parent_fd, source, destination):
    if rename_mode == "conflict" and destination == "adc.json":
        fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
            dir_fd=parent_fd,
        )
        try:
            os.write(fd, b"foreign-receipt")
            os.fsync(fd)
        finally:
            os.close(fd)
    if rename_mode == "failure" and destination == "certificate_config.json":
        raise OSError(5, "injected publication failure")
    module._link_noreplace_for_tests(parent_fd, source, destination)

try:
    receipt = module.prepare_source(
        config,
        require_root=False,
        rename_noreplace=publish,
    )
    print(json.dumps({"ok": True, "receipt": receipt}, sort_keys=True))
except module.PreparationError as error:
    print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
    raise SystemExit(1)
`;

function hostPython() {
  const result = spawnSync("python3", [
    "-c",
    "import json,sys;print(json.dumps({'path':sys.executable,'version':'.'.join(map(str,sys.version_info[:3]))}))",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "xingheng-real-test-wif-helper-"));
  chmodSync(root, 0o700);
  const stage = join(root, "var/lib/xingheng-real-test/gcp-wif-build", VERSION);
  const rootHome = join(root, "root");
  const fakeBin = join(root, "usr/bin");
  const sdkRoot = join(root, "usr/lib/google-cloud-sdk");
  const sdkBin = join(sdkRoot, "bin");
  const sdkLib = join(sdkRoot, "lib/googlecloudsdk/core");
  const bundledPythonBin = join(sdkRoot, "platform/bundledpythonunix/bin");
  const dpkgInfo = join(root, "var/lib/dpkg/info");
  const state = join(root, "fixture-state");
  for (const directory of [
    stage,
    rootHome,
    fakeBin,
    sdkBin,
    sdkLib,
    bundledPythonBin,
    dpkgInfo,
    state,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  }
  chmodSync(stage, 0o700);
  chmodSync(rootHome, 0o700);
  chmodSync(state, 0o700);

  const key = join(stage, KEY_NAME);
  const cert = join(stage, CERT_NAME);
  const generated = spawnSync(
    HOST_OPENSSL,
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert,
      "-subj", "/CN=xingheng-test-fixture",
      "-days", "1", "-sha256",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  chmodSync(key, 0o400);
  chmodSync(cert, 0o400);

  const python = hostPython();
  const fixturePython = join(bundledPythonBin, "python3");
  const fakeMode = join(state, "fake-mode");
  writeFileSync(fakeMode, "success\n", { mode: 0o600 });
  writeFileSync(
    fixturePython,
    `#!/bin/sh
mode="$(/bin/cat ${JSON.stringify(fakeMode)})"
case "$mode" in
  prefix-bad) unset PYTHONPYCACHEPREFIX ;;
  isolation-wrong-mode) /bin/chmod 0755 "$PYTHONPYCACHEPREFIX" ;;
  isolation-nonempty) printf x > "$PYTHONPYCACHEPREFIX/foreign.pyc" ;;
  isolation-inode-drift)
    /bin/mv "$PYTHONPYCACHEPREFIX" "$PYTHONPYCACHEPREFIX.old"
    /bin/mkdir -m 0700 "$PYTHONPYCACHEPREFIX"
    ;;
esac
exec ${JSON.stringify(python.path)} "$@"
`,
    { mode: 0o755 },
  );
  const fixtureDash = join(fakeBin, "dash");
  writeFileSync(fixtureDash, "#!/bin/sh\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
  writeFileSync(
    join(fakeBin, "openssl"),
    `#!/bin/sh\nexec ${JSON.stringify(HOST_OPENSSL)} "$@"\n`,
    { mode: 0o755 },
  );

  writeFileSync(join(sdkRoot, "lib/googlecloudsdk/__init__.py"), "", { mode: 0o644 });
  writeFileSync(join(sdkRoot, "lib/googlecloudsdk/core/__init__.py"), "", { mode: 0o644 });
  writeFileSync(join(sdkLib, "config.py"), "VALUE = 'fixture-safe-source'\n", { mode: 0o644 });

  const fakeProgram = join(state, "fake-gcloud.cjs");
  const fakeGcloud = join(sdkBin, "gcloud");
  const callCount = join(state, "call-count");
  writeFileSync(callCount, "0\n", { mode: 0o600 });
  writeFileSync(
    fakeGcloud,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeProgram)} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    fakeProgram,
    `
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const sdkRoot = ${JSON.stringify(sdkRoot)};
const mode = fs.readFileSync(path.join(state, "fake-mode"), "utf8").trim();
let calls = Number(fs.readFileSync(path.join(state, "call-count"), "utf8").trim()) + 1;
fs.writeFileSync(path.join(state, "call-count"), String(calls) + "\\n");
const args = process.argv.slice(2);
if (process.env.AMBIENT_SENTINEL || process.env.HTTP_PROXY || process.env.PYTHONPATH) process.exit(91);
if (process.env.PATH !== "/usr/bin:/bin") process.exit(92);
if (process.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING !== "true") process.exit(93);
if (args[0] === "version") {
  if (args.length !== 2 || args[1] !== "--format=json") process.exit(89);
  const components = ${JSON.stringify(COMPONENTS)};
  if (mode === "version-mismatch" || (mode === "second-version-mismatch" && calls >= 3)) {
    components["Google Cloud SDK"] = "575.0.0";
  }
  if (mode === "component-extra") components.extra = "1";
  if (mode === "write-config") fs.writeFileSync(path.join(process.env.CLOUDSDK_CONFIG, "config"), "x");
  if (mode === "write-pycache") fs.writeFileSync(path.join(process.env.PYTHONPYCACHEPREFIX, "cache.pyc"), "x");
  if (mode === "sdk-baseline-drift") {
    const cache = path.join(sdkRoot, "lib/googlecloudsdk/core/__pycache__");
    fs.mkdirSync(cache, {recursive: true, mode: 0o755});
    fs.writeFileSync(path.join(cache, "drift.pyc"), "x", {mode: 0o644});
  }
  process.stdout.write(JSON.stringify(components));
  process.exit(0);
}
const expectedPrefix = [
  "iam",
  "workload-identity-pools",
  "create-cred-config",
  "projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509",
];
if (
  args.length !== 9
  || expectedPrefix.some((value, index) => args[index] !== value)
  || args[8] !== "--quiet"
  || args.some((argument) =>
    argument.startsWith("--credential-cert-trust-chain-path")
    || argument.startsWith("--service-account"))
) process.exit(89);
const value = (prefix) => {
  const item = args.find((argument) => argument.startsWith(prefix + "="));
  if (!item) process.exit(90);
  return item.slice(prefix.length + 1);
};
const certPath = value("--credential-cert-path");
const keyPath = value("--credential-cert-private-key-path");
const configPath = value("--credential-cert-configuration-output-file");
const adcPath = value("--output-file");
const certificate = {certificate_config_location: configPath};
const adc = {
  type: "external_account",
  audience: ${JSON.stringify(AUDIENCE)},
  subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
  token_url: "https://sts.mtls.googleapis.com/v1/token",
  credential_source: {certificate},
};
const config = {cert_configs: {workload: {cert_path: certPath, key_path: keyPath}}};
if (mode === "unknown") adc.unknown = true;
if (mode === "impersonation") adc.service_account_impersonation_url = "https://example.invalid";
if (mode === "client-email") adc.client_email = "forbidden@example.invalid";
if (mode === "private-key") adc.private_key = "test-only-forbidden-material";
if (mode === "unknown-source") adc.credential_source = {file: "/forbidden/token"};
if (mode === "trust-chain") certificate.trust_chain_path = "/forbidden/trust-chain.pem";
if (mode === "bad-json") {
  fs.writeFileSync(adcPath, "{", {mode: 0o600});
} else {
  fs.writeFileSync(adcPath, JSON.stringify(adc), {mode: 0o600});
}
if (mode !== "partial") fs.writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
if (mode === "tool-drift-create") fs.appendFileSync(${JSON.stringify(fakeGcloud)}, "\\n# drift\\n");
if (mode === "gcloud-failure") process.exit(1);
`,
    { mode: 0o644 },
  );

  writeFileSync(
    join(fakeBin, "dpkg-query"),
    `#!/bin/sh
case "$*" in
  *google-cloud-cli) printf '%s' 'google-cloud-cli|576.0.0-test|fixture|ii' ;;
  *dash) printf '%s' 'dash|0.5.12-test|fixture|ii' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(fakeBin, "dpkg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const sdkObjects = [];
  function collect(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      sdkObjects.push(`/${path.slice(root.length + 1)}`);
      if (lstatSync(path).isDirectory()) collect(path);
    }
  }
  collect(sdkRoot);
  writeFileSync(
    join(dpkgInfo, "google-cloud-cli.list"),
    `${sdkObjects.sort().join("\n")}\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    join(dpkgInfo, "google-cloud-cli.md5sums"),
    "fixture-md5-receipt\n",
    { mode: 0o644 },
  );

  return {
    root,
    stage,
    key,
    cert,
    fakeMode,
    callCount,
    sdkRoot,
    fixturePython,
    pythonVersion: python.version,
    source: join(root, SOURCE),
    audienceFile: join(root, AUDIENCE_FILE),
    pycache: join(root, "root/.xingheng-real-test-gcloud-pycache-d2b1"),
    gcloudConfig: join(root, "root/.xingheng-real-test-gcloud-config-d2b1"),
  };
}

function runHarness(fixture, extraEnv = {}) {
  return spawnSync("python3", ["-c", PYTHON_HARNESS], {
    encoding: "utf8",
    env: {
      ...process.env,
      HELPER,
      FIXTURE_ROOT: fixture.root,
      FIXTURE_PYTHON_VERSION: fixture.pythonVersion,
      AMBIENT_SENTINEL: "must-not-be-inherited",
      HTTP_PROXY: "http://127.0.0.1:9",
      PYTHONPATH: "/forbidden",
      ...extraEnv,
    },
  });
}

function outputJson(result) {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function assertNoPreparedOutput(fixture) {
  assert.equal(existsSync(fixture.source), false);
  assert.equal(existsSync(fixture.audienceFile), false);
}

function setMode(fixture, mode) {
  writeFileSync(fixture.fakeMode, `${mode}\n`, { mode: 0o600 });
}

test("prepares exact four-file direct-root source with isolated canonical tools", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:RSA )?PRIVATE KEY/u);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN CERTIFICATE/u);
    assert.deepEqual(readdirSync(fixture.source).sort(), [
      "adc.json",
      "certificate_config.json",
      CERT_NAME,
      KEY_NAME,
    ].sort());
    assert.equal(readFileSync(fixture.audienceFile, "utf8"), `${AUDIENCE}\n`);
    assert.equal(existsSync(fixture.pycache), false);
    assert.equal(existsSync(fixture.gcloudConfig), false);
    for (const name of readdirSync(fixture.source)) {
      const metadata = lstatSync(join(fixture.source, name));
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.nlink, 1);
      assert.equal(metadata.mode & 0o777, 0o400);
    }
    const adc = JSON.parse(readFileSync(join(fixture.source, "adc.json"), "utf8"));
    assert.deepEqual(adc.credential_source.certificate, {
      certificate_config_location: "/run/secrets/gcp-wif/certificate_config.json",
    });
    assert.equal("service_account_impersonation_url" in adc, false);
    assert.equal(existsSync(join(fixture.source, "trust-chain.pem")), false);
    const verified = spawnSync(
      process.execPath,
      [VERIFIER, "source", "real-test", fixture.source, fixture.audienceFile],
      { encoding: "utf8" },
    );
    assert.equal(verified.status, 0, verified.stderr);
    const receipt = outputJson(result).receipt;
    assert.equal(receipt.gcloud.path, "/usr/lib/google-cloud-sdk/bin/gcloud");
    assert.equal(receipt.gcloud.dash_path, "/usr/bin/dash");
    assert.deepEqual(receipt.gcloud.components, COMPONENTS);
    assert.deepEqual(receipt.isolation_cleanup, {
      "/root/.xingheng-real-test-gcloud-config-d2b1": "missing",
      "/root/.xingheng-real-test-gcloud-pycache-d2b1": "missing",
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects preexisting isolation and output boundaries without overwrite", async (t) => {
  const cases = [
    ["regular source", (f) => writeFileSync(f.source, "existing", { mode: 0o400 })],
    ["symlink source", (f) => symlinkSync(f.stage, f.source)],
    ["hardlinked audience", (f) => linkSync(f.key, f.audienceFile)],
    ["regular pycache", (f) => writeFileSync(f.pycache, "existing", { mode: 0o400 })],
    ["symlink config", (f) => symlinkSync(f.stage, f.gcloudConfig)],
    ["directory pycache", (f) => mkdirSync(f.pycache, { mode: 0o700 })],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        mutate(fixture);
        const result = runHarness(fixture);
        assert.notEqual(result.status, 0);
        if (!name.includes("source") && !name.includes("audience")) {
          assertNoPreparedOutput(fixture);
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("isolation semantics fail closed before source creation", async (t) => {
  for (const mode of [
    "prefix-bad",
    "isolation-wrong-mode",
    "isolation-nonempty",
    "isolation-inode-drift",
    "write-config",
    "write-pycache",
  ]) {
    await t.test(mode, () => {
      const fixture = makeFixture();
      try {
        setMode(fixture, mode);
        const result = runHarness(fixture);
        assert.notEqual(result.status, 0, result.stdout);
        assertNoPreparedOutput(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("tool, package, component, and SDK drift stop before key copy", async (t) => {
  const cases = [
    ["gcloud receipt", { GCLOUD_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["dash receipt", { DASH_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["python receipt", { PYTHON_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["package", { GCLOUD_PACKAGE_OVERRIDE: "wrong" }, null],
    ["manifest", { LIST_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["version", {}, (f) => setMode(f, "version-mismatch")],
    ["component exact-set", {}, (f) => setMode(f, "component-extra")],
    ["SDK OTHER", {}, (f) => writeFileSync(join(f.sdkRoot, "foreign.py"), "x")],
    ["SDK unsafe cache", {}, (f) => {
      const cache = join(f.sdkRoot, "lib/__pycache__");
      mkdirSync(cache, { mode: 0o755 });
      writeFileSync(join(cache, "x.pyc"), "x", { mode: 0o666 });
      chmodSync(join(cache, "x.pyc"), 0o666);
    }],
    ["SDK external symlink", {}, (f) => symlinkSync("/tmp", join(f.sdkRoot, "escape"))],
    ["SDK baseline", {}, (f) => setMode(f, "sdk-baseline-drift")],
  ];
  for (const [name, env, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        mutate?.(fixture);
        const result = runHarness(fixture, env);
        assert.notEqual(result.status, 0, result.stdout);
        assertNoPreparedOutput(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("prefix control loads malicious pyc while isolated prefix loads safe source", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-pycache-prefix-"));
  try {
    const source = join(root, "safe.py");
    const compile = join(root, "compile.py");
    const cache = join(root, "__pycache__");
    writeFileSync(source, "VALUE = 'safe'\n");
    writeFileSync(
      compile,
      "import py_compile,sys;py_compile.compile(sys.argv[1], cfile=sys.argv[2], dfile=sys.argv[1], invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)\n",
    );
    mkdirSync(cache);
    const tag = spawnSync("python3", ["-c", "import sys;print(sys.implementation.cache_tag)"], {
      encoding: "utf8",
    }).stdout.trim();
    const pyc = join(cache, `safe.${tag}.pyc`);
    writeFileSync(source, "VALUE = 'malicious'\n");
    const compiled = spawnSync("python3", [compile, source, pyc], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    writeFileSync(source, "VALUE = 'safe'\n");
    const control = spawnSync("python3", ["-c", `import sys;sys.path.insert(0,${JSON.stringify(root)});import safe;print(safe.VALUE)`], {
      encoding: "utf8",
    });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(control.stdout.trim(), "malicious");
    const prefix = join(root, "prefix");
    mkdirSync(prefix);
    const isolated = spawnSync("python3", ["-c", `import sys;sys.path.insert(0,${JSON.stringify(root)});import safe;print(safe.VALUE);print(sys.pycache_prefix)`], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPYCACHEPREFIX: prefix,
      },
    });
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.deepEqual(isolated.stdout.trim().split("\n"), ["safe", prefix]);
    assert.deepEqual(readdirSync(prefix), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects frozen input and gcloud output drift with receipt cleanup", async (t) => {
  const cases = [
    ["input inode", { KEY_INO_OFFSET: "1" }, null],
    ["input hash", { KEY_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["input hardlink", {}, (f) => linkSync(f.key, `${f.key}.copy`)],
    ["gcloud failure", {}, (f) => setMode(f, "gcloud-failure")],
    ["partial", {}, (f) => setMode(f, "partial")],
    ["unknown", {}, (f) => setMode(f, "unknown")],
    ["impersonation", {}, (f) => setMode(f, "impersonation")],
    ["client email", {}, (f) => setMode(f, "client-email")],
    ["private key", {}, (f) => setMode(f, "private-key")],
    ["unknown source", {}, (f) => setMode(f, "unknown-source")],
    ["trust chain", {}, (f) => setMode(f, "trust-chain")],
    ["bad JSON", {}, (f) => setMode(f, "bad-json")],
    ["second version", {}, (f) => setMode(f, "second-version-mismatch")],
    ["tool drift after create", {}, (f) => setMode(f, "tool-drift-create")],
  ];
  for (const [name, env, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        mutate?.(fixture);
        const result = runHarness(fixture, env);
        assert.notEqual(result.status, 0, result.stdout);
        assertNoPreparedOutput(fixture);
        assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:RSA )?PRIVATE KEY/u);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("no-replace collision preserves foreign inode and stops cleanup", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture, { RENAME_MODE: "conflict" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(fixture.source, "adc.json"), "utf8"), "foreign-receipt");
    assert.equal(existsSync(fixture.audienceFile), false);
    assert.match(outputJson(result).error, /cleanup stopped/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publication failure removes only batch-created receipt objects", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture, { RENAME_MODE: "failure" });
    assert.notEqual(result.status, 0);
    assertNoPreparedOutput(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production and extra parameters are rejected by the fixed CLI", () => {
  for (const args of [["production"], ["real-test", "/tmp/source"], []]) {
    const result = spawnSync("python3", [HELPER, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/u);
  }
  if (process.getuid() !== 0) {
    const result = spawnSync("python3", [HELPER, "real-test"], { encoding: "utf8" });
    assert.equal(result.status, 77);
    assert.match(result.stderr, /requires root/u);
  }
});
