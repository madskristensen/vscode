#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const util = require('util');
const opn = require('opn');
const minimist = require('minimist');
const fancyLog = require('fancy-log');
const ansiColors = require('ansi-colors');

const APP_ROOT = path.join(__dirname, '..', '..');
const EXTENSIONS_ROOT = path.join(APP_ROOT, 'extensions');
const WEB_MAIN = path.join(APP_ROOT, 'src', 'vs', 'code', 'browser', 'workbench', 'workbench-dev.html');

const args = minimist(process.argv, {
	boolean: [
		'watch',
		'no-launch',
		'help'
	],
	string: [
		'scheme',
		'host',
		'port',
		'local_port'
	],
});

if (args.help) {
	console.log(
		'yarn web [options]\n' +
		' --watch       Watch extensions that require browser specific builds\n' +
		' --no-launch   Do not open VSCode web in the browser\n' +
		' --scheme      Protocol (https or http)\n' +
		' --host        Remote host\n' +
		' --port        Remote/Local port\n' +
		' --local_port  Local port override\n' +
		' --help\n' +
		'[Example]\n' +
		' yarn web --scheme https --host example.com --port 8080 --local_port 30000'
	);
	process.exit(0);
}

const PORT = args.port || process.env.PORT || 8080;
const LOCAL_PORT = args.local_port || process.env.LOCAL_PORT || PORT;
const SCHEME = args.scheme || process.env.VSCODE_SCHEME || 'http';
const HOST = args.host || 'localhost';
const AUTHORITY = process.env.VSCODE_AUTHORITY || `${HOST}:${PORT}`;

const exists = (path) => util.promisify(fs.exists)(path);
const readFile = (path) => util.promisify(fs.readFile)(path);

let unbuiltExensions = [];

async function initialize() {
	const builtinExtensions = [];

	const children = await util.promisify(fs.readdir)(EXTENSIONS_ROOT, { withFileTypes: true });
	const folders = children.filter(c => !c.isFile());
	await Promise.all(folders.map(async folder => {
		const folderName = folder.name;
		const extensionPath = path.join(EXTENSIONS_ROOT, folderName);

		let children = [];
		try {
			children = await util.promisify(fs.readdir)(extensionPath);
		} catch (error) {
			console.log(error);
			return;
		}

		const readme = children.filter(child => /^readme(\.txt|\.md|)$/i.test(child))[0];
		const readmePath = readme ? path.join(extensionPath, readme) : undefined;
		const changelog = children.filter(child => /^changelog(\.txt|\.md|)$/i.test(child))[0];
		const changelogPath = changelog ? path.join(extensionPath, changelog) : undefined;

		const packageJSONPath = path.join(EXTENSIONS_ROOT, folderName, 'package.json');
		if (await exists(packageJSONPath)) {
			try {
				const packageJSON = JSON.parse((await readFile(packageJSONPath)).toString());
				if (packageJSON.main && !packageJSON.browser) {
					return; // unsupported
				}

				if (packageJSON.browser) {
					packageJSON.main = packageJSON.browser;

					let mainFilePath = path.join(EXTENSIONS_ROOT, folderName, packageJSON.browser);
					if (path.extname(mainFilePath) !== '.js') {
						mainFilePath += '.js';
					}
					if (!await exists(mainFilePath)) {
						unbuiltExensions.push(path.relative(EXTENSIONS_ROOT, mainFilePath))
					}
				}
				packageJSON.extensionKind = ['web']; // enable for Web

				const packageNLSPath = path.join(folderName, 'package.nls.json');
				const packageNLSExists = await exists(path.join(EXTENSIONS_ROOT, packageNLSPath));
				builtinExtensions.push({
					extensionPath: folderName,
					packageJSON,
					packageNLSPath: packageNLSExists ? packageNLSPath : undefined,
					readmePath,
					changelogPath
				});
			} catch (e) {
				console.log(e);
			}
		}
	}));
	if (unbuiltExensions.length) {
		fancyLog(`${ansiColors.yellow('Warning')}: Make sure to run ${ansiColors.cyan('yarn gulp watch-web')}\nCould not find the following browser main files: \n${unbuiltExensions.join('\n')}`);
	}
	return builtinExtensions;
}

const builtinExtensionsPromise = initialize();

const mapCallbackUriToRequestId = new Map();

const server = http.createServer((req, res) => {
	const parsedUrl = url.parse(req.url, true);
	const pathname = parsedUrl.pathname;

	try {
		if (pathname === '/favicon.ico') {
			// favicon
			return serveFile(req, res, path.join(APP_ROOT, 'resources', 'win32', 'code.ico'));
		}
		if (pathname === '/manifest.json') {
			// manifest
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({
				'name': 'Code Web - OSS',
				'short_name': 'Code Web - OSS',
				'start_url': '/',
				'lang': 'en-US',
				'display': 'standalone'
			}));
		}
		if (/^\/static\//.test(pathname)) {
			// static requests
			return handleStatic(req, res, parsedUrl);
		}
		if (/^\/static-extension\//.test(pathname)) {
			// static extension requests
			return handleStaticExtension(req, res, parsedUrl);
		}
		if (pathname === '/') {
			// main web
			return handleRoot(req, res);
		} else if (pathname === '/callback') {
			// callback support
			return handleCallback(req, res, parsedUrl);
		} else if (pathname === '/fetch-callback') {
			// callback fetch support
			return handleFetchCallback(req, res, parsedUrl);
		}

		return serveError(req, res, 404, 'Not found.');
	} catch (error) {
		console.error(error.toString());

		return serveError(req, res, 500, 'Internal Server Error.');
	}
});

server.listen(LOCAL_PORT, () => {
	if (LOCAL_PORT !== PORT) {
		console.log(`Operating location at http://0.0.0.0:${LOCAL_PORT}`);
	}
	console.log(`Web UI available at   ${SCHEME}://${AUTHORITY}`);
});

server.on('error', err => {
	console.error(`Error occurred in server:`);
	console.error(err);
});

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 */
function handleStatic(req, res, parsedUrl) {

	// Strip `/static/` from the path
	const relativeFilePath = path.normalize(decodeURIComponent(parsedUrl.pathname.substr('/static/'.length)));

	return serveFile(req, res, path.join(APP_ROOT, relativeFilePath));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 */
function handleStaticExtension(req, res, parsedUrl) {

	// Strip `/static-extension/` from the path
	const relativeFilePath = path.normalize(decodeURIComponent(parsedUrl.pathname.substr('/static-extension/'.length)));

	const filePath = path.join(EXTENSIONS_ROOT, relativeFilePath);

	return serveFile(req, res, filePath);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleRoot(req, res) {
	const match = req.url && req.url.match(/\?([^#]+)/);
	let ghPath;
	if (match) {
		const qs = new URLSearchParams(match[1]);
		ghPath = qs.get('gh');
		if (ghPath && !ghPath.startsWith('/')) {
			ghPath = '/' + ghPath;
		}
	}

	const builtinExtensions = await builtinExtensionsPromise;

	const webConfigJSON = escapeAttribute(JSON.stringify({
		folderUri: ghPath
			? { scheme: 'github', authority: 'HEAD', path: ghPath }
			: { scheme: 'memfs', path: `/sample-folder` },
		builtinExtensionsServiceUrl: `${SCHEME}://${AUTHORITY}/static-extension`
	}));

	const data = (await util.promisify(fs.readFile)(WEB_MAIN)).toString()
		.replace('{{WORKBENCH_WEB_CONFIGURATION}}', () => webConfigJSON) // use a replace function to avoid that regexp replace patterns ($&, $0, ...) are applied
		.replace('{{WORKBENCH_BUILTIN_EXTENSIONS}}', () => escapeAttribute(JSON.stringify(builtinExtensions)))
		.replace('{{WEBVIEW_ENDPOINT}}', '')
		.replace('{{REMOTE_USER_DATA_URI}}', '');

	res.writeHead(200, { 'Content-Type': 'text/html' });
	return res.end(data);
}

/**
 * Handle HTTP requests for /callback
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
*/
async function handleCallback(req, res, parsedUrl) {
	const wellKnownKeys = ['vscode-requestId', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'];
	const [requestId, vscodeScheme, vscodeAuthority, vscodePath, vscodeQuery, vscodeFragment] = wellKnownKeys.map(key => {
		const value = getFirstQueryValue(parsedUrl, key);
		if (value) {
			return decodeURIComponent(value);
		}

		return value;
	});

	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	// merge over additional query values that we got
	let query = vscodeQuery;
	let index = 0;
	getFirstQueryValues(parsedUrl, wellKnownKeys).forEach((value, key) => {
		if (!query) {
			query = '';
		}

		const prefix = (index++ === 0) ? '' : '&';
		query += `${prefix}${key}=${value}`;
	});


	// add to map of known callbacks
	mapCallbackUriToRequestId.set(requestId, JSON.stringify({ scheme: vscodeScheme || 'code-oss', authority: vscodeAuthority, path: vscodePath, query, fragment: vscodeFragment }));
	return serveFile(req, res, path.join(APP_ROOT, 'resources', 'serverless', 'callback.html'), { 'Content-Type': 'text/html' });
}

/**
 * Handle HTTP requests for /fetch-callback
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
*/
async function handleFetchCallback(req, res, parsedUrl) {
	const requestId = getFirstQueryValue(parsedUrl, 'vscode-requestId');
	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	const knownCallbackUri = mapCallbackUriToRequestId.get(requestId);
	if (knownCallbackUri) {
		mapCallbackUriToRequestId.delete(requestId);
	}

	res.writeHead(200, { 'Content-Type': 'text/json' });
	return res.end(knownCallbackUri);
}

/**
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 * @param {string} key
 * @returns {string | undefined}
*/
function getFirstQueryValue(parsedUrl, key) {
	const result = parsedUrl.query[key];
	return Array.isArray(result) ? result[0] : result;
}

/**
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 * @param {string[] | undefined} ignoreKeys
 * @returns {Map<string, string>}
*/
function getFirstQueryValues(parsedUrl, ignoreKeys) {
	const queryValues = new Map();

	for (const key in parsedUrl.query) {
		if (ignoreKeys && ignoreKeys.indexOf(key) >= 0) {
			continue;
		}

		const value = getFirstQueryValue(parsedUrl, key);
		if (typeof value === 'string') {
			queryValues.set(key, value);
		}
	}

	return queryValues;
}

/**
 * @param {string} value
 */
function escapeAttribute(value) {
	return value.replace(/"/g, '&quot;');
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} errorMessage
 */
function serveError(req, res, errorCode, errorMessage) {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

const textMimeType = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
};

const mapExtToMediaMimes = {
	'.bmp': 'image/bmp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.jpe': 'image/jpg',
	'.jpeg': 'image/jpg',
	'.jpg': 'image/jpg',
	'.png': 'image/png',
	'.tga': 'image/x-tga',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.woff': 'application/font-woff'
};

/**
 * @param {string} forPath
 */
function getMediaMime(forPath) {
	const ext = path.extname(forPath);

	return mapExtToMediaMimes[ext.toLowerCase()];
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} filePath
 */
async function serveFile(req, res, filePath, responseHeaders = Object.create(null)) {
	try {

		// Sanity checks
		filePath = path.normalize(filePath); // ensure no "." and ".."
		if (filePath.indexOf(`${APP_ROOT}${path.sep}`) !== 0) {
			// invalid location outside of APP_ROOT
			return serveError(req, res, 400, `Bad request.`);
		}

		const stat = await util.promisify(fs.stat)(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType[path.extname(filePath)] || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		console.error(error.toString());
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

if (args.launch !== false) {
	opn(`${SCHEME}://${HOST}:${PORT}`);
}
