// Purpose: lets any report download take ?cols=a,b (which columns to keep) and ?listColumns=1 (which columns exist) without every
//   report's query DTO having to declare them.
// Important: the global validation pipe refuses query fields a DTO does not list, so these two are taken out of the URL here, before
//   Nest parses it, and left on res.locals for sendReport() (reports/report-export.ts) to read.
import type { NextFunction, Request, Response } from 'express';

export interface ReportColumnParams {
  cols: string[];
  list: boolean;
}

export function reportColumnsParam(req: Request, res: Response, next: NextFunction): void {
  const url = req.url;
  if (!url.includes('cols=') && !url.includes('listColumns=')) return next();
  const [path, query = ''] = url.split('?');
  const kept: string[] = [];
  const params: ReportColumnParams = { cols: [], list: false };
  for (const part of query.split('&')) {
    const [rawKey, rawValue = ''] = part.split('=');
    if (rawKey === 'cols') params.cols = decodeURIComponent(rawValue).split(',').map((c) => c.trim()).filter(Boolean);
    else if (rawKey === 'listColumns') params.list = rawValue === '1';
    else if (part) kept.push(part);
  }
  res.locals.reportColumns = params;
  req.url = kept.length ? `${path}?${kept.join('&')}` : path;
  next();
}
