import PDFDocument from "pdfkit";
import { env } from "../config/env";
import { Prospect } from "../agents/placesProspectorAgent";
import { OpportunityRecord } from "../types/opportunity";
import { openai } from "./openaiClient";
import { childLogger } from "../config/logger";

const log = childLogger("ProposalPdf");

interface ProposalContent {
  executiveSummary: string;
  scopeOfWork: string[];
  timeline: string;
  whyUs: string;
  nextSteps: string;
}

async function generateProposalContent(
  context: string,
  recipientName: string
): Promise<ProposalContent> {
  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [{
      role: "user",
      content: `Generate a professional service proposal for ${env.COMPANY_NAME} offering ${env.COMPANY_SERVICE}.

Client context: ${context}
Recipient: ${recipientName}
Company: ${env.COMPANY_NAME}

Return JSON with:
- executiveSummary: 2-3 sentences overview
- scopeOfWork: array of 4-6 specific deliverables
- timeline: estimated project timeline (e.g. "4-6 weeks")
- whyUs: 2-3 sentences on why ${env.COMPANY_NAME} is the right choice
- nextSteps: 1-2 sentences on proposed next steps`,
    }],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });
  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  return {
    executiveSummary: raw.executiveSummary ?? "",
    scopeOfWork: Array.isArray(raw.scopeOfWork) ? raw.scopeOfWork : [],
    timeline: raw.timeline ?? "4-6 weeks",
    whyUs: raw.whyUs ?? "",
    nextSteps: raw.nextSteps ?? "",
  };
}

function buildPdf(content: ProposalContent, recipientName: string, date: string): Buffer {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const primary = "#1a1a2e";
    const accent = "#0066cc";

    // Header
    doc.rect(0, 0, doc.page.width, 80).fill(primary);
    doc.fillColor("white").fontSize(22).font("Helvetica-Bold")
      .text(env.COMPANY_NAME, 50, 25);
    doc.fontSize(11).font("Helvetica")
      .text(env.COMPANY_SERVICE, 50, 52);

    doc.moveDown(3);

    // Title
    doc.fillColor(primary).fontSize(18).font("Helvetica-Bold")
      .text("Service Proposal", { align: "center" });
    doc.fontSize(11).font("Helvetica").fillColor("#666")
      .text(`Prepared for: ${recipientName}   |   Date: ${date}`, { align: "center" });

    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(accent).lineWidth(1).stroke();
    doc.moveDown(1);

    // Executive Summary
    doc.fillColor(accent).fontSize(13).font("Helvetica-Bold").text("Executive Summary");
    doc.moveDown(0.3);
    doc.fillColor("#333").fontSize(11).font("Helvetica").text(content.executiveSummary, { lineGap: 4 });
    doc.moveDown(1);

    // Scope of Work
    doc.fillColor(accent).fontSize(13).font("Helvetica-Bold").text("Scope of Work");
    doc.moveDown(0.3);
    for (const item of content.scopeOfWork) {
      doc.fillColor("#333").fontSize(11).font("Helvetica")
        .text(`• ${item}`, { indent: 10, lineGap: 3 });
    }
    doc.moveDown(1);

    // Timeline
    doc.fillColor(accent).fontSize(13).font("Helvetica-Bold").text("Estimated Timeline");
    doc.moveDown(0.3);
    doc.fillColor("#333").fontSize(11).font("Helvetica").text(content.timeline);
    doc.moveDown(1);

    // Why Us
    doc.fillColor(accent).fontSize(13).font("Helvetica-Bold").text(`Why ${env.COMPANY_NAME}`);
    doc.moveDown(0.3);
    doc.fillColor("#333").fontSize(11).font("Helvetica").text(content.whyUs, { lineGap: 4 });
    doc.moveDown(1);

    // Next Steps
    doc.fillColor(accent).fontSize(13).font("Helvetica-Bold").text("Next Steps");
    doc.moveDown(0.3);
    doc.fillColor("#333").fontSize(11).font("Helvetica").text(content.nextSteps, { lineGap: 4 });

    // Footer
    const footerY = doc.page.height - 50;
    doc.moveTo(50, footerY - 10).lineTo(doc.page.width - 50, footerY - 10)
      .strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.fillColor("#999").fontSize(9).font("Helvetica")
      .text(
        `${env.COMPANY_NAME}${env.COMPANY_CONTACT_EMAIL ? "  |  " + env.COMPANY_CONTACT_EMAIL : ""}${env.COMPANY_WEBSITE ? "  |  " + env.COMPANY_WEBSITE : ""}`,
        50, footerY, { align: "center" }
      );

    doc.end();
  }) as unknown as Buffer;
}

export async function generateProspectProposal(prospect: Prospect): Promise<Buffer> {
  log.info({ name: prospect.name }, "Generating prospect proposal PDF");
  const context = `${prospect.name} is a ${prospect.businessType} in ${prospect.address}. ${prospect.pitchReason}`;
  const content = await generateProposalContent(context, prospect.name);
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return buildPdf(content, prospect.name, date);
}

export async function generateOpportunityProposal(opp: OpportunityRecord): Promise<Buffer> {
  log.info({ title: opp.title }, "Generating opportunity proposal PDF");
  const context = `${opp.title ?? opp.rawTitle} — ${opp.summary ?? ""}. Budget: ${opp.budgetText ?? "TBD"}. Technologies: ${opp.technologies.join(", ")}`;
  const content = await generateProposalContent(context, opp.company ?? "Prospective Client");
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return buildPdf(content, opp.company ?? "Prospective Client", date);
}
