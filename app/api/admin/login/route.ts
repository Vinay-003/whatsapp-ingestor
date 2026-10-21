import { NextResponse } from 'next/server';
import { checkPassword, createSessionToken, adminCookie } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
	let password: unknown;
	try {
		const body = (await request.json()) as { password?: unknown };
		password = body.password;
	} catch {
		return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 });
	}

	if (!checkPassword(typeof password === 'string' ? password : undefined)) {
		// A short delay makes brute forcing less convenient.
		await new Promise(r => setTimeout(r, 500));
		return NextResponse.json({ ok: false, error: 'invalid password' }, { status: 401 });
	}

	const response = NextResponse.json({ ok: true });
	response.cookies.set(adminCookie.name, createSessionToken(), {
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		maxAge: adminCookie.maxAge
	});
	return response;
}
