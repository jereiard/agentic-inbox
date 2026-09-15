// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Resend API key. The existing EMAIL name is retained for compatibility. */
	EMAIL: string;
	/** Ollama Cloud API key used by the email agent and auto-draft model. */
	OLLAMA_API_KEY: string;
}
