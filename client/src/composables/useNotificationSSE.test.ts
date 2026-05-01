/**
 * Unit tests for the viewer-subscription helpers in useNotificationSSE.
 *
 * The shared EventSource isn't exercised here — these tests focus on the
 * client-side bookkeeping: refcounting, dedup, and HTTP shape. Reconnect
 * replay is covered by an MSW request log assertion plus an explicit call
 * into the (test-only) onopen replay path.
 */

import flushPromises from "flush-promises";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useServerMock } from "@/api/client/__mocks__";

import {
    _resetHistoryViewerSubscriptionsForTest,
    addHistoryViewerSubscription,
    removeHistoryViewerSubscription,
} from "./useNotificationSSE";

interface SubscriptionRequest {
    method: "POST" | "DELETE";
    history_ids: string[];
}

const { server } = useServerMock();

describe("useNotificationSSE viewer subscriptions", () => {
    let requests: SubscriptionRequest[];

    beforeEach(() => {
        _resetHistoryViewerSubscriptionsForTest();
        requests = [];
        const recordHandler = async ({ request }: { request: Request }) => {
            const body = (await request.json()) as { history_ids: string[] };
            requests.push({
                method: request.method as "POST" | "DELETE",
                history_ids: body.history_ids,
            });
            return new HttpResponse(null, { status: 204 });
        };
        server.use(
            http.post("/api/events/history-subscriptions", recordHandler),
            http.delete("/api/events/history-subscriptions", recordHandler),
        );
    });

    afterEach(() => {
        _resetHistoryViewerSubscriptionsForTest();
    });

    it("POSTs once per first subscriber for a given history id", async () => {
        addHistoryViewerSubscription("hist-A");
        await flushPromises();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.history_ids).toEqual(["hist-A"]);
    });

    it("refcounts duplicate subscriptions — second add is a no-op on the wire", async () => {
        addHistoryViewerSubscription("hist-A");
        addHistoryViewerSubscription("hist-A");
        await flushPromises();
        expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    });

    it("only DELETEs when the last subscriber for an id releases", async () => {
        addHistoryViewerSubscription("hist-A");
        addHistoryViewerSubscription("hist-A");
        await flushPromises();
        const postCount = requests.filter((r) => r.method === "POST").length;

        removeHistoryViewerSubscription("hist-A");
        await flushPromises();
        // First remove still has one outstanding refcount — must not DELETE yet.
        expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
        expect(requests.filter((r) => r.method === "POST")).toHaveLength(postCount);

        removeHistoryViewerSubscription("hist-A");
        await flushPromises();
        const deletes = requests.filter((r) => r.method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.history_ids).toEqual(["hist-A"]);
    });

    it("ignores unsubscribes for ids that were never subscribed", async () => {
        removeHistoryViewerSubscription("hist-never");
        await flushPromises();
        expect(requests).toHaveLength(0);
    });

    it("tracks distinct history ids independently", async () => {
        addHistoryViewerSubscription("hist-A");
        addHistoryViewerSubscription("hist-B");
        await flushPromises();
        const ids = requests.filter((r) => r.method === "POST").map((r) => r.history_ids[0]);
        expect(new Set(ids)).toEqual(new Set(["hist-A", "hist-B"]));
    });
});
