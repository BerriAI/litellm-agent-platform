/**
 * Next.js instrumentation hook — runs once when a new Next.js server
 * instance is initiated, before it starts handling requests.
 *
 * We use this to spawn the reconciler / warm-pool / SessionEvent
 * subscriber loops inside the Next.js process. Collapses what used to be
 * two services (`litellm-agents-web` + `litellm-agents-worker` on Render)
 * into a single container, eliminating the asymmetric-deploy footgun
 * where the web service deploys a new contract but the worker stays on
 * old code (or vice versa) and writes silently drop.
 *
 * Docs: https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  // `register` is invoked in every runtime (edge + nodejs). The worker
  // uses prisma + undici + the kube client — none of that runs on the
  // edge runtime, so gate to nodejs only. Also gates out build-time
  // evaluation of the file.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Operator escape hatch — set DISABLE_WORKER=true to run the Next.js
  // server without the background loops (e.g. while running a dedicated
  // out-of-process worker for a migration window).
  if (process.env.DISABLE_WORKER === "true") return;

  // Dynamic import keeps the worker code out of the edge runtime bundle
  // and avoids loading prisma / undici / kube-client during edge eval.
  const { startWorker } = await import("@/worker");

  // Fire-and-forget: don't block server startup on the worker. The loops
  // are designed to run forever; if startWorker() ever rejects, log and
  // let the Next.js server keep serving requests (better degraded than
  // dead).
  void startWorker().catch((err) => {
    console.error("[instrumentation] worker crashed:", err);
  });
}
