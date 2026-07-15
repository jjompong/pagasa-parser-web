# PAGASA Parser Web

This fork powers [Maybagyoba](https://maybagyoba.site) and tracks the original
[`pagasa-parser/pagasa-parser-web`](https://github.com/pagasa-parser/pagasa-parser-web)
project. It adds production safeguards for malformed or slow bulletins while
preserving the upstream API.

![Screenshot of the interface](/.github/images/screenshot-1.png)
PAGASA Parser Web combines all PAGASA Parser formatters together with [@pagasa-parser/source-pdf](https://github.com/jjompong/source-pdf) to automatically scrape the [PAGASA website](http://bagong.pagasa.dost.gov.ph) for bulletins. This means you can run the PAGASA Parser anytime, anywhere, with all bulletins currently available and format them to your heart's content.

You can find a live version of this website at [pagasa.chlod.net](https://pagasa.chlod.net). If you wish to run your own version of PAGASA Parser Web, it is also available as a [Docker image](https://hub.docker.com/r/chlod/pagasa-parser-web) (available at port 80).
![Screenshot of the landing page](/.github/images/screenshot-2.png)

Hosting for pagasa.chlod.net is provided by Chlod Alejandro. If you'd like to help alleviate server costs, please consider sponsoring this project.

## Usage
Running PAGASA Parser standalone requires Java to run the PDF parser in [@pagasa-parser/source-pdf](https://github.com/jjompong/source-pdf) (Tabula). Aside from this, you'll need Node.js 20. You'll need to build both the backend and frontend first before use. The default port for the web server is 12464.

### Parse resilience

- Concurrent requests for one bulletin share a single parser process.
- Failed downloads and parses persist under `data/parse-failures/` and retry at
  1 minute, 5 minutes, 15 minutes, 1 hour, then hourly.
- `GET /api/v1/bulletin/has/:file` exposes `downloading`, `parsing`,
  `parseFailure`, and `retryAfterSeconds` for operational checks.
- Parse responses include `Server-Timing`; cooldown responses include
  `Retry-After`.
- Parser events are emitted as one-line JSON records with the
  `pagasa_parser.*` event prefix.
- At one hour of continuous failure, the parser sends one deduplicated Discord
  alert and continues hourly retries. A successful parse sends one recovery
  notification. It reuses Dawn v3's Discord incoming-webhook payload pattern,
  pointed at a dedicated Maybagyoba channel through `ALERT_WEBHOOK_URL` and
  `PAUL_DISCORD_USER_ID`. `PARSER_IMAGE_REF` identifies the deployed image; no
  webhook value is stored in this repository.

The bundled [`ops/pagasa-parser-warm.sh`](ops/pagasa-parser-warm.sh) warmer
uses those states rather than a separate "seen" list, so an unparseable PDF is
not launched every minute. It uses PAGASA's `cyclone.dat` marker to prioritize
the active cyclone's newest bulletin instead of relying on the API's filename
ordering. The matching systemd service and timer are included in `ops/`;
installing or restarting them is a separate production rollout step.

## Docker
The Docker container contains everything needed to run PAGASA Parser and also exposes the web server at port 80. To get started easily, run the following command in your preferred shell. This will run the PAGASA Parser on port 12464.
```shell
docker run -d --name pagasa-parser-web -p 12464:80 ghcr.io/jjompong/pagasa-parser-web:latest
```

The following environment variables are available for customization of the instance.
* `PORT` – The internal port of the server
* `PPW_OWNER` – The owner of the instance. This is used in the user agent when making outbound requests.
* `PAGASA_PARSER_TABULA_TIMEOUT_MS` – Maximum runtime for each Tabula extraction mode (default: 45000).
* `ALERT_WEBHOOK_URL` – Optional Discord incoming webhook for persistent parser failures and recoveries.
* `PAUL_DISCORD_USER_ID` – Optional Discord user ID mentioned by parser alerts.
* `PARSER_IMAGE_REF` – Deployed image tag or digest included in parser alerts.

## Development
Before starting, install all dependencies on the root project, `/frontend`, and `/backend`. 
```shell
npm install # This install dependencies on all three.
```
After installing dependencies, run the `dev` npm script on the root repository to start a development session.

```shell
npm run dev
```
Port 12464 will be used for the web server (which will *not* run the web interface if not compiled) and port 12465 will be used for the Webpack Development Server. Since the Webpack Development Server is set up to automatically proxy all non-interface connections to port 12464, you only need to access port 12465 to begin working on both frontend and backend.

Frontend changes are applied immediately (instantaneously for CSS) by Webpack. Changes to the web server will restart the web server.

If at any point you wish to delete build artifacts, use the `clean` script.

## License
Unlike other PAGASA Parser libraries and repositories, this repository is licensed under the GNU Affero General Public License v3.0. This means that any changes that are either published or made available over a network must be under the GNU AGPL v3.0 license as well. The rationale for using this license stems from its primary purpose: it is a project which processes Public Domain information for the sake of disaster preparedness and management. Since it is a project made for public benefit, it is only fair that this project is licensed under the AGPL to ensure the mutual benefit of all users.

Data generated by PAGASA Parser Web are faithful recreations of data under the public domain (PAGASA Tropical Cyclone Bulletins) and are therefore part of the public domain as well. You may use the data in whatever application or project you want. Attribution of this project is not required, but is appreciated by the developers.

## Warning
Please avoid misusing the interface in a way that may cause the servers of PAGASA to be under load. Respect the usual web crawling guidelines. You may be rate-limited or blocked entirely from access if you overuse the server resources.
