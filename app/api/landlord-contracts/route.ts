import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contracts = db.prepare('SELECT * FROM landlord_contracts ORDER BY created_at DESC').all();
  return NextResponse.json(contracts);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { property_name, rent, start_date, end_date, address, pdf_path } = data;

  const result = db.prepare(`
    INSERT INTO landlord_contracts (property_name, rent, start_date, end_date, address, pdf_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(property_name, rent, start_date, end_date, address, pdf_path || null);

  const newContract = db.prepare('SELECT * FROM landlord_contracts WHERE id = ?').get(result.lastInsertRowid);
  return NextResponse.json(newContract, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { id, property_name, rent, start_date, end_date, address, pdf_path } = data;

  db.prepare(`
    UPDATE landlord_contracts
    SET property_name = ?, rent = ?, start_date = ?, end_date = ?, address = ?, pdf_path = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(property_name, rent, start_date, end_date, address, pdf_path || null, id);

  const updated = db.prepare('SELECT * FROM landlord_contracts WHERE id = ?').get(id);
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'ID required' }, { status: 400 });
  }

  db.prepare('DELETE FROM landlord_contracts WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
