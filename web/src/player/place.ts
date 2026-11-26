import { useCallback, useRef, useState } from "react";
import type { Json, Output, PlanView } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { asCards } from "./blockData";
import type { Branch, Neighbour, PlayerProps, SourceRef, Waiting } from "./players";

/**
 * Where an output sits in its plan: position, the made things before and
 * after, its done tick. `onPlanChange` hears the plan as it is after a done
 * tick, so a card showing the same plan keeps up.
 */
export function usePlace(output: Output | undefined, onPlanChange?: (view: PlanView) => void) {
  const client = useApi();
  const planId = output?.planId;
  const itemId = output?.itemId;
  const plan = useLoad(() => (planId && itemId ? client.getPlan(planId) : Promise.resolve(undefined)), [client, planId, itemId]);
  const [error, setError] = useState<unknown>();
  const items = (plan.data?.items ?? []).filter((i) => i.enabled);
  const at = items.findIndex((i) => i.id === itemId);
  const item = at >= 0 ? items[at] : undefined;
  const made = (from: number, step: number): Neighbour | undefined => {
    for (let k = from; k >= 0 && k < items.length; k += step) {
      const i = items[k]!;
      if (i.outputId) return { outputId: i.outputId, title: i.title };
    }
    return undefined;
  };
  // With nothing made on a side, whether the plan still has items there: being made, or not made yet.
  const waiting = (from: number, step: number): Waiting | undefined => {
    let unmade = false;
    for (let k = from; k >= 0 && k < items.length; k += step) {
      const status = items[k]!.status;
      if (status === "queued" || status === "running") return "making";
      if (status !== "skipped" && status !== "cancelled") unmade = true;
    }
    return unmade ? "unmade" : undefined;
  };
  // The items that branch from this one: what its result decides.
  const branches: Branch[] = item ? items.filter((i) => i.parentId === item.id && i.condition).map((i) => ({ title: i.title, condition: i.condition!, made: !!i.outputId })) : [];
  const prev = at >= 0 ? made(at - 1, -1) : undefined;
  const next = at >= 0 ? made(at + 1, 1) : undefined;
  // Where the person stopped, kept on the engine so the phone and the web carry on from the same place. Writes go
  // one after another, so an older position never lands after a newer one.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const keep = useCallback(
    (progress: Json) => {
      if (!planId || !itemId) return;
      chain.current = chain.current.then(() => client.keepProgress(planId, itemId, progress)).catch(() => undefined);
    },
    [client, planId, itemId],
  );
  async function set(done: boolean, result?: Json) {
    if (!planId || !itemId || !output) return;
    setError(undefined);
    try {
      await client.markDone(planId, itemId, done ? { done, outputId: output.id, ...(result !== undefined ? { result } : {}) } : { done });
      const fresh = await client.getPlan(planId);
      plan.set(fresh);
      onPlanChange?.(fresh);
    } catch (e) {
      setError(e);
    }
  }
  return {
    view: plan.data,
    /** False until the plan is read, so a player starts from where the person stopped, not from the top. */
    ready: !planId || !itemId || plan.data?.plan.id === planId || (plan.error !== undefined && !plan.loading),
    progress: item?.progress,
    keep: item ? keep : undefined,
    known: item !== undefined,
    done: item?.done === true,
    position: item ? at + 1 : undefined,
    total: items.length,
    prev,
    next,
    branches,
    prevWaiting: at >= 0 && !prev ? waiting(at - 1, -1) : undefined,
    nextWaiting: at >= 0 && !next ? waiting(at + 1, 1) : undefined,
    set,
    error,
  };
}

/** What a player is told about its place: neighbours, the done tick, and where the person stopped. */
export function placeProps(place: ReturnType<typeof usePlace>): Omit<PlayerProps, "output" | "finish" | "sources" | "go"> {
  return {
    ...(place.prev ? { prev: place.prev } : {}),
    ...(place.next ? { next: place.next } : {}),
    ...(place.prevWaiting ? { prevWaiting: place.prevWaiting } : {}),
    ...(place.nextWaiting ? { nextWaiting: place.nextWaiting } : {}),
    ...(place.total <= 1 ? { alone: true } : {}),
    done: place.done,
    ...(place.branches.length ? { branches: place.branches } : {}),
    ...(place.known ? { record: (result: Json) => void place.set(true, result) } : {}),
    ...(place.known && !place.done ? { complete: () => void place.set(true) } : {}),
    ...(place.progress !== undefined ? { progress: place.progress } : {}),
    ...(place.keep ? { keep: place.keep } : {}),
  };
}

/** The sources an output was made from, named. */
export function useSources(output: Output | undefined): SourceRef[] {
  const client = useApi();
  const bitCites = output ? asCards(output.payload).flatMap((b) => b.cites.map((c) => c.sourceId)) : [];
  const ids = output ? [...new Set([...(output.sources ?? []).map((s) => s.sourceId), ...output.citations.map((c) => c.sourceId), ...bitCites])] : [];
  const key = ids.join(",");
  const loaded = useLoad(() => Promise.all(ids.map((sid) => client.getSource(sid).then((d) => d, () => undefined))), [client, key]);
  return ids.map((sid) => {
    const d = loaded.data?.find((x) => x?.source.id === sid);
    // A removed source still opens, and says so; so does one whose file changed after this was made (a linked folder's).
    const changed = d?.source.changedAt && output && d.source.changedAt > output.createdAt;
    return { id: sid, name: d ? `${d.source.title}${d.source.removedAt ? " (removed)" : changed ? " (its file changed since)" : ""}` : "A source" };
  });
}
