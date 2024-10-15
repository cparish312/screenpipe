import * as fs from "fs";
import nodemailer from "nodemailer";
import { ContentItem, pipe } from "screenpipe";
import process from "node:process";
import Exa from "exa-js"

interface ScreenTopicQuery {
  query: string;
  highlights: string[]; 
  quality: number; 
}

interface FinalSummaryQuery {
  summary_query: string;
  quality: number; 
}

function getRandomOffsets(total: number, count: number): number[] {
  const offsets = new Set<number>();
  while (offsets.size < count) {
    offsets.add(Math.floor(Math.random() * total));
  }
  return Array.from(offsets);
}

async function sendEmail(
  to: string,
  password: string,
  subject: string,
  body: string
): Promise<void> {
  // Create a transporter using SMTP
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", // Replace with your SMTP server
    port: 587,
    secure: false, // Use TLS
    auth: {
      user: to, // assuming the sender is the same as the recipient
      pass: password,
    },
  });

  // Send mail with defined transport object
  const info = await transporter.sendMail({
    from: to, // sender address
    to: to, // list of receivers
    subject: subject, // Subject line
    html: body, // plain text body
  });

  if (!info) {
    throw new Error("failed to send email");
  }
  console.log(`email sent to ${to} with subject: ${subject}`);
}

async function generateScreenTopicQuery(
  screenData: ContentItem[],
  ollamaModel: string,
  ollamaApiUrl: string
): Promise<ScreenTopicQuery> {
  const prompt = `
    You are an assistant who generates search queries for an embedding search database to help a user find content of interest.

    Below is content that has been on the user's screen recently:

    ${JSON.stringify(screenData)}

    Task:
      - Analyze the content above.
      - Identify the main themes and topics.
      - Generate a single, concise sentence that summarizes the user's interests.
      - Include as many relevant keywords and concepts from the content as possible.
      - The sentence should be suitable as a search query for finding similar content. 

    Return a JSON object with the following structure:
    {
        "query": "sentence for querying the embedding search database",
        "highlights": "Quick list of highlights used to generate the query",
        "quality": "float between 0 and 1 estimating the quality of the generated query for finding content of interest"
    }

    Rules:
    - Do not add backticks to the JSON eg \`\`\`json\`\`\` is WRONG
    - DO NOT RETURN ANYTHING BUT JSON. NO COMMENTS BELOW THE JSON.
    `;

  const response = await fetch(ollamaApiUrl, {
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Error checking goal focus log:", errorBody);
    throw new Error(
      `HTTP error! status: ${response.status}, body: ${errorBody}`
    );
  }

  const result = await response.json();

  console.log("AI answer:", result);

  const cleanedResult = result.message.content
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "") // remove start and end code block markers
    .replace(/\n/g, "") // remove newlines
    .replace(/\\n/g, "") // remove escaped newlines
    .trim(); // trim any remaining whitespace

  let parsedContent;
  try {
    parsedContent = JSON.parse(cleanedResult);
  } catch (error) {
    console.warn("failed to parse ai response:", error);
    console.warn("cleaned result:", cleanedResult);
    throw new Error("invalid ai response format");
  }
  return parsedContent
}

async function generateScreenTopicSummaryQuery(
  topicQueries: string[],
  ollamaModel: string,
  ollamaApiUrl: string
): Promise<FinalSummaryQuery> {
  const prompt = `
    You are an assistant who helps summarize multiple topic queries.

    Below are topic queries generated from recent screen content:

    ${JSON.stringify(topicQueries)}

    Task:
      - Summarize these queries into a single comprehensive query that reflects the overall themes and topics.
      - Include as many relevant keywords and concepts as possible.
      - The sentence should be suitable as a search query for finding similar content. 

    Return a JSON object with the following structure:
    {
        "summary_query": "summarized query for searching the database",
        "quality": "float between 0 and 1 estimating the quality of the summarized query"
    }

    Rules:
    - Do not add backticks to the JSON eg \`\`\`json\`\`\` is WRONG
    - DO NOT RETURN ANYTHING BUT JSON. NO COMMENTS BELOW THE JSON.
    `;

  const summarizationResponse = await fetch(ollamaApiUrl, {
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
  if (!summarizationResponse.ok) {
    const errorBody = await summarizationResponse.text();
    console.error("Error checking goal focus log:", errorBody);
    throw new Error(
      `HTTP error! status: ${summarizationResponse.status}, body: ${errorBody}`
    );
  }

  const result = await summarizationResponse.json();

  console.log("Summarize AI answer:", result);

  const cleanedResult = result.message.content
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "") // remove start and end code block markers
    .replace(/\n/g, "") // remove newlines
    .replace(/\\n/g, "") // remove escaped newlines
    .trim(); // trim any remaining whitespace

  let parsedContent;
  try {
    parsedContent = JSON.parse(cleanedResult);
  } catch (error) {
    console.warn("failed to parse ai response:", error);
    console.warn("cleaned result:", cleanedResult);
    throw new Error("invalid ai response format");
  }
  return parsedContent
}

function formatExaResultsForEmail(results: any[]): string {
  return results.map((result, index) => `
    <h2>${result.title}</h2>
    <p><strong>Author(s):</strong> ${result.author}</p>
    <p><strong>Published Date:</strong> ${new Date(result.publishedDate).toDateString()}</p>
    <p><strong>Link:</strong> <a href="${result.url}">${result.url}</a></p>
    <p><strong>Summary:</strong></p>
    <blockquote>${result.summary.substring(0, 500)}</blockquote>
    <p><strong>Relevance Score:</strong> ${result.score.toFixed(2)}</p>
    <hr/>
  `).join('');
}

async function exaSearchPipeline(): Promise<void> {
  console.log("starting exa search pipeline");

  const config = await pipe.loadPipeConfig();
  console.log("loaded config:", JSON.stringify(config, null, 2));

  const emailTime = config.emailTime;
  const emailAddress = config.emailAddress;
  const emailPassword = config.emailPassword;
  const ollamaModel = config.ollamaModel;
  const ollamaApiUrl = config.ollamaApiUrl;
  const windowName = config.windowName || "";
  const pageSize = config.pageSize;
  const contentType = config.contentType || "ocr"; // Default to 'ocr' if not specified
  const topicQueryCount = config.topicQueryCount || 10;
  const exaApiKey = config.exaApiKey

  const logsDir = `${process.env.PIPE_DIR}/logs`;
  try {
    fs.mkdirSync(logsDir);
  } catch (_error) {
    console.warn("failed to create logs dir, probably already exists");
  }

  let lastEmailSent = new Date(0); // Initialize to a past date

  // send a welcome email to announce what will happen, when it will happen, and what it will do
  const welcomeEmail = `
    Welcome to the exa search pipeline!

    This pipe will send you recommended exa content based on your screen data.

    It will run at ${emailTime} every day.

    Search query:
  `;
  await sendEmail(
    emailAddress,
    emailPassword,
    "Exa Search Pipeline",
    welcomeEmail
  );

  const [emailHour, emailMinute] = emailTime.split(":").map(Number);

  while (true) {
    try {
      const now = new Date();
      let shouldRunSearch= false;
      
      const emailTimeToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        emailHour,
        emailMinute,
      );
      shouldRunSearch =
        now >= emailTimeToday &&
        now.getTime() - lastEmailSent.getTime() > 24 * 60 * 60 * 1000;

      if (shouldRunSearch){
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const screenData = await pipe.queryScreenpipe({
          start_time: oneDayAgo.toISOString(),
          end_time: now.toISOString(),
          window_name: windowName,
          limit: pageSize,
          content_type: contentType,
        });

        if (screenData && screenData.data && screenData.data.length > 0) {
          const randomOffsets = getRandomOffsets(screenData.data.length, topicQueryCount);

          const topicQueries = [];
          for (const offset of randomOffsets) {
            const pageData = screenData.data.slice(offset, offset + pageSize); // Extract section of data
            const screenTopicQuery = await generateScreenTopicQuery(pageData, ollamaModel, ollamaApiUrl);
            topicQueries.push(screenTopicQuery.query);
          }
          const finalSummary = await generateScreenTopicSummaryQuery(topicQueries, ollamaModel, ollamaApiUrl)

          // Perform exa searchs
          const exa = new Exa(exaApiKey)

          const exaResult = await exa.searchAndContents(
            finalSummary.summary_query,
            {
              type: "neural",
              useAutoprompt: true,
              numResults: 25,
              text: true,
              summary: true
            }
          )
          
          console.log("First exa results", exaResult.results[0])
          const cleanedExaResults = formatExaResultsForEmail(exaResult.results)

          const sumEmail = `
            <h1>Exa Search Pipeline Results</h1>
            <h2>Exa Query</h2>
            <p><strong>Query:</strong> ${finalSummary.summary_query}</p>
            
            <h2>Exa Results</h2>
            <div>${cleanedExaResults}</div>
          `;
          await sendEmail(
            emailAddress,
            emailPassword,
            "Exa Search Pipeline Results",
            sumEmail
          );
          await pipe.inbox.send({
            title: "Exa Search Results",
            body: finalSummary.summary_query,
          });
          lastEmailSent = now;
        }
      }
    } catch (error) {
      console.warn("error in exa search pipeline:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 600000));
  }
}

console.log(`Starting Exa Search Pipeline`);
exaSearchPipeline();
