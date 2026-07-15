import {ApiEndpoint, ApiEndpointResponse} from "./ApiEndpoint";
import express from "express";
import {BulletinListCache} from "../../cache/BulletinListCache";
import {BulletinManager, ParseFailureRecord} from "../../bulletin/BulletinManager";

interface ParseFailureStatus extends ParseFailureRecord {
    retryAfterSeconds: number;
}

interface BulletinHasEndpointResponse extends ApiEndpointResponse {
    downloaded: boolean,
    downloading: boolean,
    parsed: boolean,
    parsing: boolean,
    parseFailure: ParseFailureStatus | null
}

export class BulletinHasEndpoint extends ApiEndpoint<BulletinHasEndpointResponse> {

    private static instance = new BulletinHasEndpoint();
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

            const failure = BulletinManager.i.getParseFailure(bulletin);
            this.send(res, {
                error: false,
                downloaded: BulletinManager.i.has(bulletin),
                downloading: BulletinManager.i.isDownloading(bulletin),
                parsed: BulletinManager.i.hasParsed(bulletin),
                parsing: BulletinManager.i.isParsing(bulletin),
                parseFailure: failure ? {
                    ...failure,
                    retryAfterSeconds: BulletinManager.i.getRetryAfterSeconds(failure)
                } : null
            });
        } else {
            this.sendError(res, "A bulletin to download was not provided.", 400);
        }
    }

}
