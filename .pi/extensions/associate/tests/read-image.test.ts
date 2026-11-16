// Tests for image input on the `read` tool (task t14).
//
// An image file reaches the model as an image content block when the ACTIVE
// registry entry declares `image` input, and is refused with a typed error
// otherwise. No shipped model is text-only, so the refusal tests run against
// a contract copy whose entry is rewritten to `input: ["text"]`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import { loadContract } from "../lib/contract.ts";
import { IMAGE_MAX_BYTES, register } from "../tools/read.ts";

type Block = { type: string; text?: string; data?: string; mimeType?: string };
interface Result {
  content: Block[];
  details: Record<string, unknown>;
}

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("0000000d49484452", "hex"), Buffer.alloc(24, 1)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 4)]);

/**
 * Register `read` with ASSOCIATE_MODEL set to `opts.model` (unset when
 * omitted). The active model is snapshotted at register time — load time in
 * pi — exactly as index.ts resolves it, so the variable must be set first.
 */
async function harness(opts: { textOnly?: string[]; model?: string } = {}) {
  if (opts.model === undefined) delete process.env.ASSOCIATE_MODEL;
  else process.env.ASSOCIATE_MODEL = opts.model;
  const runsRoot = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const env = { ASSOCIATE_EXPORT_ROOT: runsRoot, ASSOCIATE_SESSION_ID: "read-image-test" };
  const base = loadContract(env);
  const models = JSON.parse(JSON.stringify(base.models));
  for (const key of opts.textOnly ?? []) models.models[key].input = ["text"];
  const ctx = createAssociateContext({ checkoutRoot: checkout, env, contract: { ...base, models } });
  let execute: (id: string, p: unknown) => Promise<Result>;
  await register(
    { registerTool: (d: { execute: typeof execute }) => (execute = d.execute) } as unknown as Parameters<typeof register>[0],
    ctx,
  );
  return {
    checkout,
    read: (path: string) => execute("t", { path }),
    dispose: () => {
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      delete process.env.ASSOCIATE_MODEL;
    },
  };
}

for (const model of ["senses", "worker", "cortex"]) {
  test(`${model}: a PNG reaches the model as an image block`, async () => {
    const h = await harness({ model });
    try {
      writeFileSync(join(h.checkout, "pic.png"), PNG);
      const r = await h.read("pic.png");
      const image = r.content.find((b) => b.type === "image");
      assert.ok(image, JSON.stringify(r));
      assert.equal(image.mimeType, "image/png");
      assert.equal(image.data, PNG.toString("base64"));
      assert.equal(r.content[0].type, "text");
      assert.match(r.content[0].text ?? "", /image\/png/);
    } finally {
      h.dispose();
    }
  });
}

test("the default model (ASSOCIATE_MODEL unset) is resolved from the registry", async () => {
  const h = await harness();
  try {
    writeFileSync(join(h.checkout, "pic.png"), PNG);
    assert.ok((await h.read("pic.png")).content.some((b) => b.type === "image"));
  } finally {
    h.dispose();
  }
});

test("detection is by magic bytes: jpeg, gif, webp, and a PNG with a wrong extension", async () => {
  const h = await harness({ model: "worker" });
  try {
    const cases: Array<[string, Buffer, string]> = [
      ["a.jpg", JPEG, "image/jpeg"],
      ["b.gif", GIF, "image/gif"],
      ["c.webp", WEBP, "image/webp"],
      ["d.dat", PNG, "image/png"],
    ];
    for (const [name, bytes, mime] of cases) {
      writeFileSync(join(h.checkout, name), bytes);
      const image = (await h.read(name)).content.find((b) => b.type === "image");
      assert.equal(image?.mimeType, mime, name);
    }
  } finally {
    h.dispose();
  }
});

test("a .png file that is really text is read as text", async () => {
  const h = await harness({ model: "worker" });
  try {
    writeFileSync(join(h.checkout, "fake.png"), "not an image\n");
    const r = await h.read("fake.png");
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, "text");
    assert.equal(r.content[0].text, "1\tnot an image");
  } finally {
    h.dispose();
  }
});

test("a text-only entry is refused with a typed error and no image block", async () => {
  const h = await harness({ textOnly: ["worker"], model: "worker" });
  try {
    writeFileSync(join(h.checkout, "pic.png"), PNG);
    const r = await h.read("pic.png");
    assert.equal(r.content.some((b) => b.type === "image"), false);
    assert.equal(r.details.code, "image_input_unsupported");
    assert.equal(r.details.ok, false);
    assert.equal(JSON.parse(r.content[0].text ?? "").code, "image_input_unsupported");
    assert.match(String(r.details.message), /worker/);
  } finally {
    h.dispose();
  }
});

test("the refusal follows the ACTIVE entry: text-only senses refused, worker still served", async () => {
  const senses = await harness({ textOnly: ["senses"], model: "senses" });
  try {
    writeFileSync(join(senses.checkout, "pic.png"), PNG);
    assert.equal((await senses.read("pic.png")).details.code, "image_input_unsupported");
  } finally {
    senses.dispose();
  }
  const worker = await harness({ textOnly: ["senses"], model: "worker" });
  try {
    writeFileSync(join(worker.checkout, "pic.png"), PNG);
    assert.ok((await worker.read("pic.png")).content.some((b) => b.type === "image"));
  } finally {
    worker.dispose();
  }
});

test("the active model is the load-time snapshot: changing ASSOCIATE_MODEL later changes nothing", async () => {
  // index.ts resolves the model once at load (lib/toolset.ts resolveActiveModel)
  // and the tool_call guard enforces THAT model's set; read must agree with it,
  // not re-read process.env on every call.
  const h = await harness({ textOnly: ["senses"], model: "senses" });
  try {
    writeFileSync(join(h.checkout, "pic.png"), PNG);
    process.env.ASSOCIATE_MODEL = "worker";
    const r = await h.read("pic.png");
    assert.equal(r.details.code, "image_input_unsupported");
    assert.match(String(r.details.message), /'senses'/);
  } finally {
    h.dispose();
  }
});

test("a pending model (super-vl) is refused image input, like every other tool", async () => {
  const h = await harness({ model: "super-vl" });
  try {
    writeFileSync(join(h.checkout, "pic.png"), PNG);
    const r = await h.read("pic.png");
    assert.equal(r.details.code, "image_input_unsupported");
    assert.match(String(r.details.message), /super-vl/);
  } finally {
    h.dispose();
  }
});

test("an unknown ASSOCIATE_MODEL is refused (no image input can be assumed)", async () => {
  const h = await harness({ model: "nonesuch" });
  try {
    writeFileSync(join(h.checkout, "pic.png"), PNG);
    assert.equal((await h.read("pic.png")).details.code, "image_input_unsupported");
  } finally {
    h.dispose();
  }
});

test("an oversize image is refused with image_too_large", async () => {
  const h = await harness({ model: "worker" });
  try {
    writeFileSync(join(h.checkout, "big.png"), Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
    const r = await h.read("big.png");
    assert.equal(r.details.code, "image_too_large");
    assert.equal(r.content.some((b) => b.type === "image"), false);
  } finally {
    h.dispose();
  }
});

test("containment and denylist still apply to images", async () => {
  const h = await harness({ model: "worker" });
  try {
    const outside = mkdtempSync(join(tmpdir(), "associate-outside-"));
    writeFileSync(join(outside, "x.png"), PNG);
    assert.equal((await h.read(join(outside, "x.png"))).details.code, "path_escapes_root");
    symlinkSync(join(outside, "x.png"), join(h.checkout, "link.png"));
    assert.equal((await h.read("link.png")).details.code, "path_escapes_root");
    writeFileSync(join(h.checkout, ".env"), PNG);
    const denied = await h.read(".env");
    assert.equal(denied.content.some((b) => b.type === "image"), false);
    assert.equal(denied.details.ok, false);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    h.dispose();
  }
});
