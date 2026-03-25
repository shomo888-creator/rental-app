export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('zh-TW');
}

export function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

export function isExpiringSoon(endDate: string, daysThreshold: number = 30): boolean {
  const end = new Date(endDate);
  const now = new Date();
  const diffTime = end.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays <= daysThreshold && diffDays > 0;
}

export function getDaysUntilExpiry(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  const diffTime = end.getTime() - now.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}
