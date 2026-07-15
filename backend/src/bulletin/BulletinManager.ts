import path from "path";
import * as nodeFs from "fs";
import * as fs from "fs-jetpack";
import {ExpandedPAGASADocument} from "../cache/BulletinListCache";
import axios from "axios";
import md5 from "../util/md5";
import PagasaParserPDFSource from "@pagasa-parser/source-pdf";
import {Bulletin} from "pagasa-parser";
import {
    BulletinAlertDetails,
    BulletinAlertSender,
    BulletinFailureStage,
    DiscordBulletinAlertService,
    ParseTiming
} from "../alerts/BulletinAlertService";

// Retry points are measured from the first failure: 1m, 5m, 15m, then 1h.
// Subsequent attempts remain hourly so one bad PDF cannot create a hot loop.
const RETRY_AT_AGES_MS = [
    60 * 1000,
    5 * 60 * 1000,
    15 * 60 * 1000,
    60 * 60 * 1000
];
const HOURLY_RETRY_MS = 60 * 60 * 1000;
const ALERT_THRESHOLD_MS = 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageInfo = require("../../package.json");

interface BulletinManagerOptions {
    alerts?: BulletinAlertSender;
    parserVersion?: string;
    imageRef?: string;
    architecture?: string;
}

export interface ParseFailureRecord {
    file: string;
    link: string;
    stage: BulletinFailureStage;
    attempts: number;
    firstFailedAt: string;
    lastFailedAt: string;
    nextRetryAt: string;
    lastError: string;
    operationDurationMs: number;
    parseTimings: ParseTiming[];
    alertedAt?: string;
}

export class BulletinCooldownError extends Error {
    constructor(public readonly failure: ParseFailureRecord) {
        super(`${failure.file} is quarantined until ${failure.nextRetryAt}.`);
        this.name = "BulletinCooldownError";
    }
}

export class BulletinDownloadError extends Error {
    constructor(public readonly failure: ParseFailureRecord) {
        super(`Unable to download ${failure.file}.`);
        this.name = "BulletinDownloadError";
    }
}

export class BulletinParseError extends Error {
    constructor(public readonly failure: ParseFailureRecord) {
        super(`Unable to parse ${failure.file}.`);
        this.name = "BulletinParseError";
    }
}

export class BulletinManager {

    private static instance = new BulletinManager();
    static get i() { return this.instance; }

    private dataDirectory: string;
    private bulletinsDirectory: string;
    private parsedDirectory: string;
    private failuresDirectory: string;
    private readonly parseInFlight = new Map<string, Promise<Bulletin>>();
    private readonly downloadInFlight = new Map<string, Promise<void>>();
    private alerts: BulletinAlertSender;
    private parserVersion: string;
    private imageRef: string;
    private architecture: string;

    private constructor() { /* private constructor */ }

    initialize(dataDirectory: string, options: BulletinManagerOptions = {}) {
        this.dataDirectory = dataDirectory;
        this.bulletinsDirectory = path.join(this.dataDirectory, "bulletins");
        this.parsedDirectory = path.join(this.dataDirectory, "parsed");
        this.failuresDirectory = path.join(this.dataDirectory, "parse-failures");
        this.parseInFlight.clear();
        this.downloadInFlight.clear();
        this.alerts = options.alerts ?? new DiscordBulletinAlertService();
        this.parserVersion = options.parserVersion ??
            `pagasa-parser-web/${packageInfo.version} source-pdf/${packageInfo.dependencies["@pagasa-parser/source-pdf"]}`;
        this.imageRef = options.imageRef ?? process.env.PARSER_IMAGE_REF ?? "unknown";
        this.architecture = options.architecture ?? process.arch;

        for (const directory of [
            this.bulletinsDirectory,
            this.parsedDirectory,
            this.failuresDirectory
        ]) {
            if (fs.exists(directory) !== "dir") {
                fs.dir(directory);
            }
        }
    }

    getPDFPath(document: ExpandedPAGASADocument): string {
        return path.join(this.bulletinsDirectory, md5(document.file) + ".pdf");
    }

    getJSONPath(document: ExpandedPAGASADocument): string {
        return path.join(this.parsedDirectory, md5(document.file) + ".json");
    }

    getFailurePath(document: ExpandedPAGASADocument): string {
        return path.join(this.failuresDirectory, md5(document.file) + ".json");
    }

    has(document: ExpandedPAGASADocument): boolean {
        return fs.exists(this.getPDFPath(document)) !== false;
    }

    async get(document: ExpandedPAGASADocument): Promise<string> {
        if (!fs.exists(this.getPDFPath(document))) {
            await this.download(document);
        }
        return this.getPDFPath(document);
    }

    async download(document: ExpandedPAGASADocument): Promise<void> {
        if (this.has(document)) return;

        this.enforceCooldown(document);
        const existingDownload = this.downloadInFlight.get(document.file);
        if (existingDownload) {
            this.log("download_deduplicated", document.file);
            return existingDownload;
        }

        const downloadPromise = this.downloadAndPersist(document);
        this.downloadInFlight.set(document.file, downloadPromise);
        try {
            await downloadPromise;
        } finally {
            this.downloadInFlight.delete(document.file);
        }
    }

    hasParsed(document: ExpandedPAGASADocument): boolean {
        return fs.exists(this.getJSONPath(document)) !== false;
    }

    isParsing(document: ExpandedPAGASADocument): boolean {
        return this.parseInFlight.has(document.file);
    }

    isDownloading(document: ExpandedPAGASADocument): boolean {
        return this.downloadInFlight.has(document.file);
    }

    getParseFailure(document: ExpandedPAGASADocument): ParseFailureRecord | null {
        try {
            return fs.read(this.getFailurePath(document), "json") as ParseFailureRecord ?? null;
        } catch (_) {
            return null;
        }
    }

    getRetryAfterSeconds(failure: ParseFailureRecord): number {
        return Math.max(0, Math.ceil((Date.parse(failure.nextRetryAt) - Date.now()) / 1000));
    }

    async parse(document: ExpandedPAGASADocument): Promise<Bulletin> {
        if (this.hasParsed(document)) {
            return fs.read(this.getJSONPath(document), "jsonWithDates");
        }

        const existingParse = this.parseInFlight.get(document.file);
        if (existingParse) {
            this.log("parse_deduplicated", document.file);
            return existingParse;
        }

        this.enforceCooldown(document);

        const parsePromise = this.parseAndPersist(document);
        this.parseInFlight.set(document.file, parsePromise);
        try {
            return await parsePromise;
        } finally {
            this.parseInFlight.delete(document.file);
        }
    }

    private enforceCooldown(document: ExpandedPAGASADocument): void {
        const failure = this.getParseFailure(document);
        if (failure && this.getRetryAfterSeconds(failure) > 0) {
            this.log("bulletin_cooldown", document.file, {
                stage: failure.stage,
                attempts: failure.attempts,
                nextRetryAt: failure.nextRetryAt
            });
            throw new BulletinCooldownError(failure);
        }
    }

    private async downloadAndPersist(document: ExpandedPAGASADocument): Promise<void> {
        const startedAt = Date.now();
        try {
            const pdf = await axios(document.link, {
                responseType: "arraybuffer",
                timeout: 60000
            });
            this.writeAtomic(this.getPDFPath(document), Buffer.from(pdf.data));
            this.log("download_succeeded", document.file, {
                durationMs: Date.now() - startedAt
            });
        } catch (error) {
            const failure = await this.recordFailure(
                document,
                "download",
                error,
                Date.now() - startedAt,
                []
            );
            this.log("download_failed", document.file, {
                durationMs: failure.operationDurationMs,
                attempts: failure.attempts,
                nextRetryAt: failure.nextRetryAt,
                error: failure.lastError
            });
            throw new BulletinDownloadError(failure);
        }
    }

    private async parseAndPersist(document: ExpandedPAGASADocument): Promise<Bulletin> {
        const startedAt = Date.now();
        let parser: (PagasaParserPDFSource & {tabulaTimings?: ParseTiming[]}) | null = null;
        try {
            parser = new PagasaParserPDFSource(this.getPDFPath(document));
            const parsed = await parser.parse();
            parsed.info.url = document.link;

            this.writeJSONAtomic(this.getJSONPath(document), parsed);
            const previousFailure = this.getParseFailure(document);
            if (previousFailure?.alertedAt) {
                const recoveryDetails = this.alertDetails(
                    document,
                    previousFailure,
                    Date.now() - startedAt,
                    parser.tabulaTimings ?? []
                );
                const sent = await this.alerts.sendRecovery(recoveryDetails);
                this.log("recovery_notification", document.file, {sent});
            }
            fs.remove(this.getFailurePath(document));
            this.log("parse_succeeded", document.file, {
                durationMs: Date.now() - startedAt
            });
            return parsed;
        } catch (error) {
            const failure = await this.recordFailure(
                document,
                "parse",
                error,
                Date.now() - startedAt,
                parser?.tabulaTimings ?? []
            );
            this.log("parse_failed", document.file, {
                durationMs: failure.operationDurationMs,
                attempts: failure.attempts,
                nextRetryAt: failure.nextRetryAt,
                error: failure.lastError
            });
            throw new BulletinParseError(failure);
        }
    }

    private async recordFailure(
        document: ExpandedPAGASADocument,
        stage: BulletinFailureStage,
        error: unknown,
        operationDurationMs: number,
        parseTimings: ParseTiming[]
    ): Promise<ParseFailureRecord> {
        const previous = this.getParseFailure(document);
        const attempts = (previous?.attempts ?? 0) + 1;
        const now = new Date();
        const firstFailedAt = previous?.firstFailedAt ?? now.toISOString();
        const firstFailedMs = Date.parse(firstFailedAt);
        const failure: ParseFailureRecord = {
            file: document.file,
            link: document.link,
            stage,
            attempts,
            firstFailedAt,
            lastFailedAt: now.toISOString(),
            nextRetryAt: this.nextRetryAt(attempts, firstFailedMs, now.getTime()).toISOString(),
            lastError: this.errorMessage(error),
            operationDurationMs,
            parseTimings,
            alertedAt: previous?.alertedAt
        };
        this.writeJSONAtomic(this.getFailurePath(document), failure);

        const elapsedMs = Math.max(0, now.getTime() - firstFailedMs);
        if (elapsedMs >= ALERT_THRESHOLD_MS && !failure.alertedAt) {
            const sent = await this.alerts.sendFailure(
                this.alertDetails(document, failure, operationDurationMs, parseTimings)
            );
            if (sent) {
                failure.alertedAt = now.toISOString();
                this.writeJSONAtomic(this.getFailurePath(document), failure);
            }
            this.log("failure_notification", document.file, {sent, elapsedMs});
        }
        return failure;
    }

    private nextRetryAt(attempts: number, firstFailedMs: number, nowMs: number): Date {
        if (attempts <= RETRY_AT_AGES_MS.length) {
            const scheduledMs = firstFailedMs + RETRY_AT_AGES_MS[attempts - 1];
            return new Date(scheduledMs > nowMs ? scheduledMs : nowMs + 60 * 1000);
        }
        return new Date(nowMs + HOURLY_RETRY_MS);
    }

    private alertDetails(
        document: ExpandedPAGASADocument,
        failure: ParseFailureRecord,
        operationDurationMs: number,
        parseTimings: ParseTiming[]
    ): BulletinAlertDetails {
        return {
            file: document.file,
            link: document.link,
            stage: failure.stage,
            error: failure.lastError,
            firstFailedAt: failure.firstFailedAt,
            elapsedMs: Math.max(0, Date.now() - Date.parse(failure.firstFailedAt)),
            attempts: failure.attempts,
            parserVersion: this.parserVersion,
            imageRef: this.imageRef,
            architecture: this.architecture,
            operationDurationMs,
            parseTimings
        };
    }

    private writeJSONAtomic(filePath: string, data: unknown): void {
        this.writeAtomic(filePath, JSON.stringify(data));
    }

    private writeAtomic(filePath: string, data: string | Buffer): void {
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        nodeFs.writeFileSync(temporaryPath, data);
        nodeFs.renameSync(temporaryPath, filePath);
    }

    private errorMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return message.replace(/\s+/g, " ").slice(0, 500);
    }

    private log(event: string, file: string, data: Record<string, unknown> = {}): void {
        console.log(JSON.stringify({
            event: `pagasa_parser.${event}`,
            file,
            ...data
        }));
    }

}
