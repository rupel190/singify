/**
 * serve.ts — tiny Bun dev server for the browser harness.
 * Bundles dev/harness.tsx on each request (no watch cache) and serves it.
 *
 *   bun run dev   →   http://localhost:3000  (or the next free port)
 *
 * Override the port with PORT=3001 bun run dev. If the chosen port is busy we
 * fall back to a free one instead of crashing with EADDRINUSE.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir);
const PORT = Number(process.env.PORT ?? 3000);

async function handler(req: Request): Promise<Response> {
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
}

// Prefer $PORT, but degrade gracefully: if it's taken, bind a free port (0)
// rather than crashing. server.port below reports whichever we actually got.
function serve(port: number) {
  try {
    return Bun.serve({ port, fetch: handler });
  } catch (err) {
    // Bun's message is "Is port N in use?" and the code is on err.code.
    const code = (err as { code?: string })?.code;
    const inUse = code === "EADDRINUSE" || /in use/i.test(String(err));
    if (inUse && port !== 0) {
      console.warn(`⚠ port ${port} is in use — falling back to a free port`);
      return Bun.serve({ port: 0, fetch: handler });
    }
    throw err;
  }
}

const server = serve(PORT);
console.log(`singify harness → http://localhost:${server.port}`);
