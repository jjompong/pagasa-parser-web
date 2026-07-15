import * as nodeFs from "fs";
import os from "os";
import path from "path";

const mockParse = jest.fn();
const mockAxios = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: mockAxios
}));

jest.mock("@pagasa-parser/source-pdf", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        parse: mockParse,
        tabulaTimings: [
            {mode: "stream", status: "succeeded", durationMs: 120},
            {mode: "lattice", status: "succeeded", durationMs: 140}
        ]
    }))
}));

import {
    BulletinCooldownError,
    BulletinDownloadError,
    BulletinManager,
    BulletinParseError
} from "../src/bulletin/BulletinManager";
import {BulletinAlertSender} from "../src/alerts/BulletinAlertService";
import {ExpandedPAGASADocument} from "../src/cache/BulletinListCache";

const document: ExpandedPAGASADocument = {
    name: "josie",
    count: 3,
    final: true,
    file: "TCB#3_josie.pdf",
    link: "https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin/TCB%233_josie.pdf"
};

const parsedBulletin = {
    info: {},
    cyclone: {},
    signals: {}
};

const otherDocument: ExpandedPAGASADocument = {
    name: "francisco",
    count: 21,
    final: false,
    file: "TCB#21_francisco.pdf",
    link: "https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin/TCB%2321_francisco.pdf"
};

describe("BulletinManager parse resilience", () => {
    let dataDirectory: string;
    let alerts: jest.Mocked<BulletinAlertSender>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
        mockParse.mockReset();
        mockAxios.mockReset();
        alerts = {
            sendFailure: jest.fn().mockResolvedValue(true),
            sendRecovery: jest.fn().mockResolvedValue(true)
        };
        dataDirectory = nodeFs.mkdtempSync(path.join(os.tmpdir(), "pagasa-parser-web-"));
        BulletinManager.i.initialize(dataDirectory, {
            alerts,
            parserVersion: "pagasa-parser-web/1.3.0 source-pdf/test-sha",
            imageRef: "ghcr.io/jjompong/pagasa-parser-web:test",
            architecture: "arm64"
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        nodeFs.rmSync(dataDirectory, {recursive: true, force: true});
    });

    test("deduplicates concurrent requests for the same bulletin", async () => {
        let resolveParse: (value: unknown) => void;
        mockParse.mockReturnValue(new Promise(resolve => {
            resolveParse = resolve;
        }));

        const first = BulletinManager.i.parse(document);
        const second = BulletinManager.i.parse(document);
        expect(BulletinManager.i.isParsing(document)).toBe(true);
        expect(mockParse).toHaveBeenCalledTimes(1);

        resolveParse(parsedBulletin);
        await Promise.all([first, second]);

        expect(BulletinManager.i.isParsing(document)).toBe(false);
        expect(BulletinManager.i.hasParsed(document)).toBe(true);
    });

    test("persists a failed parse and blocks immediate retry", async () => {
        mockParse.mockRejectedValueOnce(new Error("coordinate pattern not found"));

        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );
        const failure = BulletinManager.i.getParseFailure(document);
        expect(failure).not.toBeNull();
        expect(failure?.attempts).toBe(1);
        expect(BulletinManager.i.getRetryAfterSeconds(failure!)).toBe(60);

        BulletinManager.i.initialize(dataDirectory, {alerts});
        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinCooldownError
        );
        expect(mockParse).toHaveBeenCalledTimes(1);
    });

    test("retries after cooldown and clears failure state on success", async () => {
        mockParse
            .mockRejectedValueOnce(new Error("temporary parser failure"))
            .mockResolvedValueOnce(parsedBulletin);

        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );

        jest.setSystemTime(new Date("2026-07-15T00:01:01.000Z"));
        await expect(BulletinManager.i.parse(document)).resolves.toMatchObject({
            info: {url: document.link}
        });

        expect(mockParse).toHaveBeenCalledTimes(2);
        expect(BulletinManager.i.getParseFailure(document)).toBeNull();
        expect(BulletinManager.i.hasParsed(document)).toBe(true);
    });

    test("uses 1m/5m/15m/1h retry points, then alerts and retries every five minutes", async () => {
        mockParse.mockRejectedValue(new Error("coordinate pattern not found"));
        const attempts = [
            ["2026-07-15T00:00:00.000Z", "2026-07-15T00:01:00.000Z"],
            ["2026-07-15T00:01:00.000Z", "2026-07-15T00:05:00.000Z"],
            ["2026-07-15T00:05:00.000Z", "2026-07-15T00:15:00.000Z"],
            ["2026-07-15T00:15:00.000Z", "2026-07-15T01:00:00.000Z"],
            ["2026-07-15T01:00:00.000Z", "2026-07-15T01:05:00.000Z"]
        ];

        for (const [attemptedAt, nextRetryAt] of attempts) {
            jest.setSystemTime(new Date(attemptedAt));
            await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
                BulletinParseError
            );
            expect(BulletinManager.i.getParseFailure(document)?.nextRetryAt).toBe(nextRetryAt);
        }

        expect(alerts.sendFailure).toHaveBeenCalledTimes(1);
        expect(alerts.sendFailure).toHaveBeenCalledWith(expect.objectContaining({
            file: document.file,
            link: document.link,
            stage: "parse",
            error: "coordinate pattern not found",
            firstFailedAt: "2026-07-15T00:00:00.000Z",
            elapsedMs: 60 * 60 * 1000,
            attempts: 5,
            parserVersion: "pagasa-parser-web/1.3.0 source-pdf/test-sha",
            imageRef: "ghcr.io/jjompong/pagasa-parser-web:test",
            architecture: "arm64",
            parseTimings: expect.arrayContaining([
                expect.objectContaining({mode: "stream", durationMs: 120}),
                expect.objectContaining({mode: "lattice", durationMs: 140})
            ])
        }));

        expect(BulletinManager.i.getParseFailure(document)).toMatchObject({
            alertedAt: "2026-07-15T01:00:00.000Z",
            lastAlertedAt: "2026-07-15T01:00:00.000Z",
            alertsSent: 1
        });

        // Simulate a service restart: cooldown and alert history must persist,
        // but the next failed P0 attempt still sends a new alert.
        BulletinManager.i.initialize(dataDirectory, {
            alerts,
            parserVersion: "pagasa-parser-web/1.3.0 source-pdf/test-sha",
            imageRef: "ghcr.io/jjompong/pagasa-parser-web:test",
            architecture: "arm64"
        });
        jest.setSystemTime(new Date("2026-07-15T01:04:00.000Z"));
        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinCooldownError
        );
        expect(mockParse).toHaveBeenCalledTimes(5);
        expect(alerts.sendFailure).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date("2026-07-15T01:05:00.000Z"));
        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );
        expect(alerts.sendFailure).toHaveBeenCalledTimes(2);
        expect(alerts.sendFailure).toHaveBeenLastCalledWith(expect.objectContaining({
            elapsedMs: 65 * 60 * 1000,
            attempts: 6
        }));
        expect(BulletinManager.i.getParseFailure(document)).toMatchObject({
            attempts: 6,
            nextRetryAt: "2026-07-15T01:10:00.000Z",
            alertedAt: "2026-07-15T01:00:00.000Z",
            lastAlertedAt: "2026-07-15T01:05:00.000Z",
            alertsSent: 2
        });

        mockParse.mockResolvedValueOnce(parsedBulletin);
        jest.setSystemTime(new Date("2026-07-15T01:10:00.000Z"));
        await expect(BulletinManager.i.parse(document)).resolves.toMatchObject({
            info: {url: document.link}
        });

        expect(alerts.sendFailure).toHaveBeenCalledTimes(2);
        expect(alerts.sendRecovery).toHaveBeenCalledTimes(1);
        expect(alerts.sendRecovery).toHaveBeenCalledWith(expect.objectContaining({
            file: document.file,
            stage: "parse",
            attempts: 6,
            imageRef: "ghcr.io/jjompong/pagasa-parser-web:test",
            architecture: "arm64"
        }));
        expect(BulletinManager.i.getParseFailure(document)).toBeNull();
    });

    test("quarantines only the failing bulletin and continues parsing unrelated bulletins", async () => {
        mockParse
            .mockRejectedValueOnce(new Error("malformed JOSIE coordinates"))
            .mockResolvedValueOnce(parsedBulletin);

        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );
        await expect(BulletinManager.i.parse(otherDocument)).resolves.toMatchObject({
            info: {url: otherDocument.link}
        });

        expect(BulletinManager.i.getParseFailure(document)?.attempts).toBe(1);
        expect(BulletinManager.i.getParseFailure(otherDocument)).toBeNull();
        expect(BulletinManager.i.hasParsed(otherDocument)).toBe(true);
    });

    test("uses the five-minute P0 cadence after a delayed service resume", async () => {
        mockParse.mockRejectedValue(new Error("parser remained unavailable"));

        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );

        // Only one pre-threshold attempt was recorded before a long outage.
        // Elapsed time, not attempt count, must select the P0 cadence on resume.
        jest.setSystemTime(new Date("2026-07-15T02:00:00.000Z"));
        await expect(BulletinManager.i.parse(document)).rejects.toBeInstanceOf(
            BulletinParseError
        );

        expect(BulletinManager.i.getParseFailure(document)).toMatchObject({
            attempts: 2,
            nextRetryAt: "2026-07-15T02:05:00.000Z",
            alertedAt: "2026-07-15T02:00:00.000Z",
            lastAlertedAt: "2026-07-15T02:00:00.000Z",
            alertsSent: 1
        });
        expect(alerts.sendFailure).toHaveBeenCalledTimes(1);
        expect(alerts.sendFailure).toHaveBeenCalledWith(expect.objectContaining({
            elapsedMs: 2 * 60 * 60 * 1000,
            attempts: 2
        }));
    });

    test("records download failures in the same per-bulletin quarantine", async () => {
        mockAxios.mockRejectedValueOnce(new Error("PAGASA download timed out"));

        await expect(BulletinManager.i.download(document)).rejects.toBeInstanceOf(
            BulletinDownloadError
        );
        const failure = BulletinManager.i.getParseFailure(document);
        expect(failure).toMatchObject({
            file: document.file,
            link: document.link,
            stage: "download",
            attempts: 1,
            lastError: "PAGASA download timed out",
            nextRetryAt: "2026-07-15T00:01:00.000Z"
        });
        expect(BulletinManager.i.has(document)).toBe(false);

        jest.setSystemTime(new Date("2026-07-15T00:00:30.000Z"));
        await expect(BulletinManager.i.download(document)).rejects.toBeInstanceOf(
            BulletinCooldownError
        );
        expect(mockAxios).toHaveBeenCalledTimes(1);
    });
});
