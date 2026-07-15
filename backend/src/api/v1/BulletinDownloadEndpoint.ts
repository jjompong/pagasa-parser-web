import {ApiEndpoint, ApiEndpointResponse} from "./ApiEndpoint";
import express from "express";
import {BulletinListCache} from "../../cache/BulletinListCache";
import {
    BulletinCooldownError,
    BulletinDownloadError,
    BulletinManager
} from "../../bulletin/BulletinManager";

interface BulletinDownloadEndpointResponse extends ApiEndpointResponse {
    downloaded: boolean;
}

export class BulletinDownloadEndpoint extends ApiEndpoint<BulletinDownloadEndpointResponse> {

    private static instance = new BulletinDownloadEndpoint();
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

            const startedAt = Date.now();
            try {
                await BulletinManager.i.get(bulletin);
                res.set("Server-Timing", `download;dur=${Date.now() - startedAt}`);
                this.send(res, {
                    error: false,
                    downloaded: true
                });
            } catch (error) {
                if (error instanceof BulletinCooldownError || error instanceof BulletinDownloadError) {
                    const retryAfter = BulletinManager.i.getRetryAfterSeconds(error.failure);
                    res.set("Retry-After", String(Math.max(1, retryAfter)));
                    res.set("Server-Timing", `download;dur=${Date.now() - startedAt}`);
                    this.sendError(
                        res,
                        error instanceof BulletinCooldownError
                            ? `Downloading is temporarily paused after ${error.failure.attempts} failed attempt(s).`
                            : "The bulletin could not be downloaded. A bounded retry has been scheduled.",
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
