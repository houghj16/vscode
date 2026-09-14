/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { FileDropReceiverAdapter } from '../../browser/fileDropReceiverAdapter.js';
import { IWebhookDelivery } from '../../common/webhookIngress.js';

const DROP = URI.from({ scheme: Schemas.inMemory, path: '/inbox-one/drop' });

function deliveryJson(id: string): string {
	return JSON.stringify({ headers: { event: 'issues', delivery: id }, rawBody: '{"x":1}', payload: { x: 1 } });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('condition not met in time');
		}
		await new Promise(r => setTimeout(r, 5));
	}
}

suite('Inbox One - file-drop receiver adapter', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(): { fileService: FileService; adapter: FileDropReceiverAdapter } {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const adapter = disposables.add(new FileDropReceiverAdapter(DROP, fileService, new NullLogService()));
		return { fileService, adapter };
	}

	test('start fires a one-time connectivity recovery (drives exactly one backfill)', async () => {
		const { adapter } = setup();
		const seen: boolean[] = [];
		disposables.add(adapter.onConnectivityChange(v => seen.push(v)));
		await adapter.start();
		assert.deepStrictEqual(seen, [true]);
	});

	test('a delivery dropped after start is emitted then consumed', async () => {
		const { fileService, adapter } = setup();
		const got: IWebhookDelivery[] = [];
		disposables.add(adapter.onDelivery(d => got.push(d)));
		await adapter.start();

		const file = joinPath(DROP, 'd1.json');
		await fileService.writeFile(file, VSBuffer.fromString(deliveryJson('d1')));

		await waitFor(() => got.length === 1);
		assert.strictEqual(got[0].headers.delivery, 'd1');
		assert.strictEqual(got[0].headers.event, 'issues');
		assert.strictEqual(got[0].rawBody, '{"x":1}');
		// The file is consumed so a reload never re-ingests it.
		assert.strictEqual(await fileService.exists(file), false);
	});

	test('deliveries already queued before start are drained on start', async () => {
		const { fileService, adapter } = setup();
		await fileService.createFolder(DROP);
		await fileService.writeFile(joinPath(DROP, 'pre.json'), VSBuffer.fromString(deliveryJson('pre')));

		const got: IWebhookDelivery[] = [];
		disposables.add(adapter.onDelivery(d => got.push(d)));
		await adapter.start();

		await waitFor(() => got.length === 1);
		assert.strictEqual(got[0].headers.delivery, 'pre');
	});

	test('non-json files in the drop dir are ignored', async () => {
		const { fileService, adapter } = setup();
		const got: IWebhookDelivery[] = [];
		disposables.add(adapter.onDelivery(d => got.push(d)));
		await adapter.start();

		await fileService.writeFile(joinPath(DROP, 'note.txt'), VSBuffer.fromString('not a delivery'));
		await fileService.writeFile(joinPath(DROP, 'ok.json'), VSBuffer.fromString(deliveryJson('ok')));

		await waitFor(() => got.length === 1);
		assert.strictEqual(got.length, 1);
		assert.strictEqual(got[0].headers.delivery, 'ok');
	});

	test('signature is not recomputed locally (verified upstream in the companion)', async () => {
		const { adapter } = setup();
		assert.strictEqual(await adapter.computeSignature('anything'), undefined);
	});
});
