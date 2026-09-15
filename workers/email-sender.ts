// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via the Resend REST API.
 *
 * The Resend API key is stored in the Worker `EMAIL` secret. This fork keeps
 * the existing `env.EMAIL` call sites, but `EMAIL` is now a string secret
 * rather than a Cloudflare `send_email` binding.
 *
 * See: https://resend.com/docs/api-reference/emails/send-email
 */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

type EmailAddress = string | { email: string; name: string };

type ResendApiResponse = {
	id?: string;
	name?: string;
	message?: string;
	statusCode?: number;
};

type ResendRetrieveResponse = {
	message_id?: string;
};

function normalizeMessageId(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function getResendMessageId(
	apiKey: string,
	emailId: string,
): Promise<string | undefined> {
	// Resend can accept the message before its final SMTP Message-ID is exposed
	// by the Retrieve Email endpoint. Retry briefly so the SENT record can be
	// reconciled with the Message-ID that recipients actually see.
	const retryDelaysMs = [0, 250, 750, 1500, 3000] as const;

	for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
		const delayMs = retryDelaysMs[attempt];
		if (delayMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}

		const response = await fetch(
			`https://api.resend.com/emails/${encodeURIComponent(emailId)}`,
			{
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			},
		);

		let result: ResendRetrieveResponse = {};
		try {
			result = (await response.json()) as ResendRetrieveResponse;
		} catch {
			// Keep an empty response so the status and retry decision are still logged.
		}

		console.log(
			`[resend] retrieve emailId=${emailId} attempt=${attempt + 1}/${retryDelaysMs.length} delayMs=${delayMs} status=${response.status} messageId=${result.message_id ?? "<missing>"}`,
		);

		if (response.ok && result.message_id) {
			return normalizeMessageId(result.message_id);
		}

		// Authentication/permission/validation errors will not improve with retry.
		if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 429) {
			console.warn(
				`Could not retrieve Resend Message-ID for ${emailId}: HTTP ${response.status}`,
			);
			return undefined;
		}
	}

	console.warn(
		`Resend Message-ID was not available after ${retryDelaysMs.length} attempts for ${emailId}`,
	);
	return undefined;
}

function formatAddress(address: EmailAddress): string {
	if (typeof address === "string") return address;
	if (!address.name) return address.email;
	const escapedName = address.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escapedName}" <${address.email}>`;
}

/**
 * Send an email using Resend's HTTPS API.
 *
 * @param apiKey - Resend API key stored in the Worker `EMAIL` secret
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns The Resend email ID as messageId
 * @throws On configuration, validation, or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string; providerMessageId?: string }> {
	if (!apiKey) {
		const error = new Error("Resend API key is not configured. Set the Worker EMAIL secret.") as Error & {
			code?: string;
		};
		error.code = "missing_resend_api_key";
		throw error;
	}

	const message: Record<string, unknown> = {
		to: params.to,
		from: formatAddress(params.from),
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.reply_to = formatAddress(params.replyTo);

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			content_type: att.type,
			content_disposition: att.disposition,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(message),
	});

	let result: ResendApiResponse = {};
	try {
		result = (await response.json()) as ResendApiResponse;
	} catch {
		// Keep an empty response object so the HTTP status is still reported below.
	}

	if (!response.ok) {
		const error = new Error(
			result.message || `Resend API request failed with HTTP ${response.status}`,
		) as Error & { code?: string; status?: number };
		error.code = result.name || "resend_api_error";
		error.status = response.status;
		throw error;
	}

	if (!result.id) {
		const error = new Error("Resend API returned a successful response without an email ID.") as Error & {
			code?: string;
		};
		error.code = "invalid_resend_response";
		throw error;
	}

	console.log(`[resend] accepted emailId=${result.id}`);
	const providerMessageId = await getResendMessageId(apiKey, result.id);
	console.log(
		`[resend] resolved emailId=${result.id} providerMessageId=${providerMessageId ?? "<unavailable>"}`,
	);
	return { messageId: result.id, providerMessageId };
}
