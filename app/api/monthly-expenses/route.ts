import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expenses = db.prepare('SELECT * FROM monthly_expenses ORDER BY year DESC, month DESC, created_at DESC').all();
  return NextResponse.json(expenses);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { tenant_name, property_name, room_number, water_dispenser, internet, cleaning, garbage, helper, rent, month, year } = data;

  const water = parseInt(water_dispenser) || 0;
  const net = parseInt(internet) || 0;
  const clean = parseInt(cleaning) || 0;
  const garb = parseInt(garbage) || 0;
  const help = parseInt(helper) || 0;
  const rentAmt = parseInt(rent) || 0;
  const total = water + net + clean + garb + help + rentAmt;

  const result = db.prepare(`
    INSERT INTO monthly_expenses (tenant_name, property_name, room_number, water_dispenser, internet, cleaning, garbage, helper, rent, total, month, year)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenant_name, property_name, room_number, water, net, clean, garb, help, rentAmt, total, month, year);

  const newExpense = db.prepare('SELECT * FROM monthly_expenses WHERE id = ?').get(result.lastInsertRowid);
  return NextResponse.json(newExpense, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();
  const { id, tenant_name, property_name, room_number, water_dispenser, internet, cleaning, garbage, helper, rent, month, year } = data;

  const water = parseInt(water_dispenser) || 0;
  const net = parseInt(internet) || 0;
  const clean = parseInt(cleaning) || 0;
  const garb = parseInt(garbage) || 0;
  const help = parseInt(helper) || 0;
  const rentAmt = parseInt(rent) || 0;
  const total = water + net + clean + garb + help + rentAmt;

  db.prepare(`
    UPDATE monthly_expenses
    SET tenant_name = ?, property_name = ?, room_number = ?, water_dispenser = ?, internet = ?, cleaning = ?, garbage = ?, helper = ?, rent = ?, total = ?, month = ?, year = ?
    WHERE id = ?
  `).run(tenant_name, property_name, room_number, water, net, clean, garb, help, rentAmt, total, month, year, id);

  const updated = db.prepare('SELECT * FROM monthly_expenses WHERE id = ?').get(id);
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

  db.prepare('DELETE FROM monthly_expenses WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
