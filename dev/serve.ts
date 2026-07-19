/**
 * serve.ts — tiny Bun dev server for the browser harness.
 * Bundles dev/harness.tsx on each request (no watch cache) and serves it.
 *
 *   bun run dev   →   http://localhost:3000
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir);
const PORT = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(ROOT, "index.html")), {
        headers: { "content-type": "text/html" },
      });
    }

    if (url.pathname === "/harness.js") {
      const build = await Bun.build({
        entrypoints: [join(ROOT, "harness.tsx")],
        target: "browser",
        define: { "process.env.NODE_ENV": '"development"' },
      });
      if (!build.success) {
        const logs = build.logs.map(String).join("\n");
        console.error(logs);
        return new Response(`/* build failed */\nconsole.error(${JSON.stringify(logs)});`, {
          status: 200,
          headers: { "content-type": "text/javascript" },
        });
      }
      return new Response(await build.outputs[0].text(), {
        headers: { "content-type": "text/javascript" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`singify harness → http://localhost:${server.port}`);
