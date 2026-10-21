import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionToken, adminCookie } from '@/lib/admin-auth';
import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';

const ALLOWED_STATUSES = new Set(['draft', 'published', 'expired', 'rejected']);

/** Update a job's moderation status. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const token = (await cookies()).get(adminCookie.name)?.value;
	if (!verifySessionToken(token)) {
		return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
	}

	const { id } = await params;
	let body: { status?: unknown };
	try {
		body = (await request.json()) as { status?: unknown };
	} catch {
		return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 });
	}

	const status = typeof body.status === 'string' ? body.status : '';
	if (!ALLOWED_STATUSES.has(status)) {
		return NextResponse.json({ ok: false, error: 'invalid status' }, { status: 400 });
	}

	const { error } = await serviceClient().from('jobs').update({ status }).eq('id', id);
	if (error) {
		return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
	}
	return NextResponse.json({ ok: true, id, status });
}
