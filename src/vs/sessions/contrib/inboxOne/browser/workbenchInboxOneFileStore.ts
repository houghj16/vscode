/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InboxOneFileStore } from './inboxOneFileStore.js';

/**
 * The {@link InboxOneFileStore} rooted under the user's roaming data home, wired
 * for dependency injection. Seeds itself on construction so the Skills view and
 * the learning loop see the durable /skills /wiki /experience tree.
 */
export class WorkbenchInboxOneFileStore extends InboxOneFileStore {
	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
	) {
		super(joinPath(environmentService.userRoamingDataHome, 'inboxOne'), fileService, logService);
		this.initialize().catch(() => { /* best-effort; consumers retry */ });
	}
}
