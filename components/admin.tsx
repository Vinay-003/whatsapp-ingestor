'use client';

import { useState } from 'react';

export function LoginForm() {
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await fetch('/api/admin/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (res.ok) {
				window.location.reload();
				return;
			}
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			setError(body?.error ?? 'login failed');
		} catch {
			setError('login failed');
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="filters" style={{ maxWidth: 420 }}>
			<input
				type="password"
				name="password"
				placeholder="Moderator password"
				value={password}
				onChange={e => setPassword(e.target.value)}
				autoComplete="current-password"
			/>
			<button type="submit" disabled={busy}>
				{busy ? 'Signing in…' : 'Sign in'}
			</button>
			{error && <span className="count">{error}</span>}
		</form>
	);
}

export function StatusButton({ id, status, next }: { id: string; status: string; next: string }) {
	const [busy, setBusy] = useState(false);
	const [current, setCurrent] = useState(status);

	async function update() {
		setBusy(true);
		try {
			const res = await fetch(`/api/admin/jobs/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status: next })
			});
			if (res.ok) setCurrent(next);
		} finally {
			setBusy(false);
		}
	}

	return (
		<button type="button" onClick={update} disabled={busy} style={{ minWidth: 110 }}>
			{busy ? '…' : current === next ? 'Done' : `→ ${next}`}
		</button>
	);
}
