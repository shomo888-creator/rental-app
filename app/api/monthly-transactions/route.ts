import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const transactions = db.prepare('SELECT * FROM monthly_transactions ORDER BY transaction_date DESC, created_at DESC').all();
  return NextResponse.json(transactions);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { type, category, amount, description, transaction_date } = data;

  const result = db.prepare(`
    INSERT INTO monthly_transactions (type, category, amount, description, transaction_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, category, parseInt(amount) || 0, description || '', transaction_date);

  const newTransaction = db.prepare('SELECT * FROM monthly_transactions WHERE id = ?').get(result.lastInsertRowid);
  return NextResponse.json(newTransaction, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { id, type, category, amount, description, transaction_date } = data;

  db.prepare(`
    UPDATE monthly_transactions
    SET type = ?, category = ?, amount = ?, description = ?, transaction_date = ?
    WHERE id = ?
  `).run(type, category, parseInt(amount) || 0, description || '', transaction_date, id);

  const updated = db.prepare('SELECT * FROM monthly_transactions WHERE id = ?').get(id);
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

  db.prepare('DELETE FROM monthly_transactions WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
