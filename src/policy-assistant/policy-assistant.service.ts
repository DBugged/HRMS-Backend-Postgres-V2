// Purpose: Employee-facing Q&A over the org's own published Policy Documents ("what's our WFH policy?",
//   "how many casual leaves do I get?") — grounded strictly in the org's actual PDFs, not general knowledge.
// Responsibilities: Resolves the caller's currently-visible/published policy PDFs (DocumentsService), attaches
//   them as native document content blocks to a single Anthropic Messages API call, and returns the answer.
// Important: Degrades gracefully (same convention as EmailService's SMTP/Resend DRY RUN) when
//   ANTHROPIC_API_KEY isn't set, or when there are no PDF policies to ground an answer in, rather than
//   erroring — this is an optional add-on, not a required system dependency. Only PDF-type, internally-stored
//   documents are ever read; an external URL-type policy is never fetched (no SSRF surface) — just its title
//   is unavailable to quote from.
import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { DocumentsService } from '../documents/documents.service';
import { readStoredFile } from '../files/file-storage.config';

type Actor = Omit<User, 'password'>;

const EXTERNAL_URL_RE = /^https?:\/\//i;
// Anthropic's document limit is 32MB/100 pages per file; well below that
// per-doc, and capped in count so one request can't balloon into a huge,
// slow, expensive payload just because an org has a large policy library.
const MAX_DOCS = 6;
const MAX_DOC_BYTES = 15 * 1024 * 1024;
const MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are the HR policy assistant for this company's HRMS. Answer the employee's question using ONLY the attached policy documents — never invent a number, date, or rule that isn't actually stated in them. If the documents don't cover the question, say so plainly and suggest they contact HR directly. Keep answers short and direct. Cite which document you drew from by name when helpful.`;

export interface AskResult {
  answer: string;
  grounded: boolean;
  sources: string[];
}

@Injectable()
export class PolicyAssistantService {
  private readonly logger = new Logger(PolicyAssistantService.name);

  constructor(private readonly documentsService: DocumentsService) {}

  async ask(
    question: string,
    actor: Actor,
    organizationId: string,
  ): Promise<AskResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        '[Policy Assistant - not configured, ANTHROPIC_API_KEY not set]',
      );
      return {
        answer:
          "The policy assistant isn't set up yet — please ask HR directly.",
        grounded: false,
        sources: [],
      };
    }

    const policies = await this.documentsService.findActivePoliciesRaw(
      actor,
      organizationId,
    );
    const candidates = policies
      .filter((p) => p.docType === 'PDF' && !EXTERNAL_URL_RE.test(p.fileUrl))
      .slice(0, MAX_DOCS);

    const documentBlocks: Array<{
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
      title: string;
    }> = [];
    for (const p of candidates) {
      const buf = await readStoredFile(p.fileUrl);
      if (!buf || buf.length > MAX_DOC_BYTES) continue;
      documentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: buf.toString('base64'),
        },
        title: p.title,
      });
    }

    if (documentBlocks.length === 0) {
      return {
        answer:
          'No policy documents are available to answer from yet — please ask HR directly.',
        grounded: false,
        sources: [],
      };
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [...documentBlocks, { type: 'text', text: question }],
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.error(
          `Policy assistant call failed: ${res.status} ${await res.text().catch(() => '')}`,
        );
        return {
          answer:
            "Sorry, I couldn't process that just now — please try again shortly or ask HR directly.",
          grounded: false,
          sources: [],
        };
      }
      const body = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const answer =
        body.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim() || "I couldn't find an answer to that in our policies.";
      return {
        answer,
        grounded: true,
        sources: documentBlocks.map((d) => d.title),
      };
    } catch (err) {
      this.logger.error(
        `Policy assistant request errored: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        answer:
          "Sorry, I couldn't reach the policy assistant just now — please try again shortly or ask HR directly.",
        grounded: false,
        sources: [],
      };
    }
  }
}
