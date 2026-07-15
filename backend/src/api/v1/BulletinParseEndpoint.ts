import {ApiEndpoint, ApiEndpointResponse} from "./ApiEndpoint";
import express from "express";
import {BulletinListCache} from "../../cache/BulletinListCache";
import {
    BulletinCooldownError,
    BulletinManager,
    BulletinParseError
} from "../../bulletin/BulletinManager";
import {Bulletin} from "pagasa-parser";

interface BulletinParseEndpointResponse extends ApiEndpointResponse {
    bulletin: Bulletin;
}

export class BulletinParseEndpoint extends ApiEndpoint<BulletinParseEndpointResponse> {

    private static instance = new BulletinParseEndpoint();
    static get i() { return this.instance; }

    private constructor() { super(); }

    async handleRequest(req: express.Request, res: express.Response): Promise<void> {
        res.set("Content-Type", "application/json");

        if (req.params.bulletin != null) {
            const bulletin = await BulletinListCache.getFromFilename(req.params.bulletin);
            if (bulletin == null) {
                this.sendError(res, "The requested bulletin is not available on PAGASA's file server.", 404);
                return;
            }

            if (!BulletinManager.i.has(bulletin)) {
                this.sendError(res, "The bulletin has not yet been cached with GET bulletin/download.", 412);
                return;
            }

            const startedAt = Date.now();
            try {
                const parsed = await BulletinManager.i.parse(bulletin);
                res.set("Server-Timing", `parser;dur=${Date.now() - startedAt}`);
                this.send(res, {
                    error: false,
                    bulletin: parsed
                });
            } catch (error) {
                if (error instanceof BulletinCooldownError || error instanceof BulletinParseError) {
                    const retryAfter = BulletinManager.i.getRetryAfterSeconds(error.failure);
                    res.set("Retry-After", String(Math.max(1, retryAfter)));
                    res.set("Server-Timing", `parser;dur=${Date.now() - startedAt}`);
                    this.sendError(
                        res,
                        error instanceof BulletinCooldownError
                            ? `Parsing is temporarily paused after ${error.failure.attempts} failed attempt(s).`
                            : "The bulletin could not be parsed. A bounded retry has been scheduled.",
                        error instanceof BulletinCooldownError ? 503 : 422
                    );
                    return;
                }
                throw error;
            }
        } else {
            this.sendError(res, "A bulletin to download was not provided.", 400);
        }
    }

}
