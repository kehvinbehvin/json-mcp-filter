#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
    quicktype,
    InputData,
    jsonInputForTargetLanguage,
    LanguageName,
    SerializedRenderResult
} from "quicktype-core";

// Import strategy pattern components
import { JsonIngestionContext } from './context/JsonIngestionContext.js';
import { JsonIngestionResult } from './types/JsonIngestion.js';

// Define input validation schemas (Support files and HTTP/HTTPS URLs)
const JsonSchemaInputSchema = z.object({
  filePath: z.string().min(1, "File path or HTTP/HTTPS URL is required").refine(
    (val) => val.length > 0 && (val.startsWith('./') || val.startsWith('/') || val.startsWith('http://') || val.startsWith('https://') || !val.includes('/')),
    "Must be a valid file path or HTTP/HTTPS URL"
  )
});

const JsonFilterInputSchema = z.object({
  filePath: z.string().min(1, "File path or HTTP/HTTPS URL is required").refine(
    (val) => val.length > 0 && (val.startsWith('./') || val.startsWith('/') || val.startsWith('http://') || val.startsWith('https://') || !val.includes('/')),
    "Must be a valid file path or HTTP/HTTPS URL"
  ),
  shape: z.any().describe("Shape object defining what to extract"),
  cursor: z.string().optional().describe("Opaque cursor token for pagination. Omit to start from the beginning.")
});

const JsonDryRunInputSchema = z.object({
  filePath: z.string().min(1, "File path or HTTP/HTTPS URL is required").refine(
    (val) => val.length > 0 && (val.startsWith('./') || val.startsWith('/') || val.startsWith('http://') || val.startsWith('https://') || !val.includes('/')),
    "Must be a valid file path or HTTP/HTTPS URL"
  ),
  shape: z.any().describe("Shape object defining what to analyze")
});

type JsonSchemaInput = z.infer<typeof JsonSchemaInputSchema>;
type JsonFilterInput = z.infer<typeof JsonFilterInputSchema>;
type JsonDryRunInput = z.infer<typeof JsonDryRunInputSchema>;
type Shape = { [key: string]: true | Shape };

// Define error types (extended to support new ingestion strategies and edge cases)
interface JsonSchemaError {
  readonly type: 'file_not_found' | 'invalid_json' | 'network_error' | 'invalid_url' | 'unsupported_content_type' | 'rate_limit_exceeded' | 'validation_error' | 'authentication_required' | 'server_error' | 'content_too_large' | 'quicktype_error';
  readonly message: string;
  readonly details?: unknown;
}

// Result type for better type safety
type JsonSchemaResult = {
  readonly success: true;
  readonly schema: string;
  readonly fileSizeBytes: number;
} | {
  readonly success: false;
  readonly error: JsonSchemaError;
};

type JsonFilterResult = {
  readonly success: true;
  readonly filteredData: any;
  readonly nextCursor?: string;
} | {
  readonly success: false;
  readonly error: JsonSchemaError;
};

type JsonDryRunResult = {
  readonly success: true;
  readonly sizeBreakdown: any;
  readonly totalSize: number;
  readonly filteredSize: number;
  readonly recommendedChunks: number;
} | {
  readonly success: false;
  readonly error: JsonSchemaError;
};

// Create server instance
const server = new McpServer({
  name: "json-mcp",
  version: "1.2.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Initialize the JSON ingestion context (Phase 1: LocalFileStrategy only)
const jsonIngestionContext = new JsonIngestionContext();

/**
 * Pagination cursor interface for MCP-compliant cursor-based pagination
 */
interface PaginationCursor {
  readonly offset: number;
  readonly pageSize: number;
  readonly totalSize: number;
}

/**
 * Encode pagination state into an opaque cursor token (base64-encoded JSON)
 */
function encodeCursor(cursor: PaginationCursor): string {
  const jsonString = JSON.stringify(cursor);
  return Buffer.from(jsonString).toString('base64');
}

/**
 * Decode an opaque cursor token back into pagination state
 * Returns null if the cursor is invalid
 */
function decodeCursor(cursorToken: string): PaginationCursor | null {
  try {
    const jsonString = Buffer.from(cursorToken, 'base64').toString('utf-8');
    const cursor = JSON.parse(jsonString) as PaginationCursor;

    // Validate cursor structure
    if (typeof cursor.offset !== 'number' ||
        typeof cursor.pageSize !== 'number' ||
        typeof cursor.totalSize !== 'number') {
      return null;
    }

    return cursor;
  } catch {
    return null;
  }
}

async function quicktypeJSON(
  targetLanguage: LanguageName, 
  typeName: string, 
  jsonString: string
): Promise<SerializedRenderResult> {
  const jsonInput = jsonInputForTargetLanguage(targetLanguage);

  await jsonInput.addSource({
    name: typeName,
    samples: [jsonString]
  });

  const inputData = new InputData();
  inputData.addInput(jsonInput);

  return await quicktype({
    inputData,
    lang: targetLanguage,
    rendererOptions: {
        "just-types": true
    }
  });
}

/**
 * Extract data from object based on shape definition
 */
function extractWithShape(data: any, shape: Shape): any {
  if (Array.isArray(data)) {
    return data.map(item => extractWithShape(item, shape));
  }

  const result: any = {};
  for (const key in shape) {
    const rule = shape[key];
    if (rule === true) {
      result[key] = data[key];
    } else if (typeof rule === 'object' && data[key] !== undefined) {
      result[key] = extractWithShape(data[key], rule);
    }
  }
  return result;
}

/**
 * Calculate the size in bytes of any JSON value
 */
function calculateValueSize(value: any): number {
  if (value === null) {
    return new TextEncoder().encode('null').length; // 4 bytes for "null"
  }
  
  if (value === undefined) {
    // undefined values are omitted in JSON.stringify, so they have 0 size
    return 0;
  }
  
  if (typeof value === 'string') {
    // Use JSON.stringify to handle escape characters properly
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }
  
  if (typeof value === 'number') {
    return new TextEncoder().encode(value.toString()).length;
  }
  
  if (typeof value === 'boolean') {
    return new TextEncoder().encode(value.toString()).length; // "true" = 4, "false" = 5
  }
  
  if (Array.isArray(value)) {
    // Calculate size of array including JSON formatting (brackets, commas)
    let totalSize = 2; // Opening and closing brackets []
    for (let i = 0; i < value.length; i++) {
      totalSize += calculateValueSize(value[i]);
      if (i < value.length - 1) {
        totalSize += 1; // Comma separator
      }
    }
    return totalSize;
  }
  
  if (typeof value === 'object') {
    // Calculate size of object including JSON formatting (braces, colons, commas, quotes)
    let totalSize = 2; // Opening and closing braces {}
    const entries = Object.entries(value).filter(([, val]) => val !== undefined);
    for (let i = 0; i < entries.length; i++) {
      const [key, val] = entries[i];
      totalSize += new TextEncoder().encode(`"${key}"`).length; // Key with quotes
      totalSize += 1; // Colon
      totalSize += calculateValueSize(val); // Value
      if (i < entries.length - 1) {
        totalSize += 1; // Comma separator
      }
    }
    return totalSize;
  }
  
  return 0;
}

/**
 * Calculate size breakdown based on shape definition
 */
function calculateSizeWithShape(data: any, shape: Shape): any {
  if (Array.isArray(data)) {
    // For arrays, apply the shape to each element and sum the results
    let totalSizeBreakdown: any = {};
    let isFirstElement = true;
    
    for (const item of data) {
      const itemSizeBreakdown = calculateSizeWithShape(item, shape);
      
      if (isFirstElement) {
        totalSizeBreakdown = itemSizeBreakdown;
        isFirstElement = false;
      } else {
        // Sum up the sizes
        totalSizeBreakdown = addSizeBreakdowns(totalSizeBreakdown, itemSizeBreakdown);
      }
    }
    
    return totalSizeBreakdown;
  }

  const result: any = {};
  for (const key in shape) {
    const rule = shape[key];
    if (data[key] === undefined) {
      // If the key doesn't exist in data, skip it or set to 0
      continue;
    }
    
    if (rule === true) {
      // Calculate total size of this key's value
      result[key] = calculateValueSize(data[key]);
    } else if (typeof rule === 'object') {
      // Recursively break down this key's value
      result[key] = calculateSizeWithShape(data[key], rule);
    }
  }
  return result;
}

/**
 * Helper function to add two size breakdown objects together
 */
function addSizeBreakdowns(breakdown1: any, breakdown2: any): any {
  if (typeof breakdown1 === 'number' && typeof breakdown2 === 'number') {
    return breakdown1 + breakdown2;
  }
  
  if (typeof breakdown1 === 'object' && typeof breakdown2 === 'object') {
    const result: any = {};
    const allKeys = new Set([...Object.keys(breakdown1), ...Object.keys(breakdown2)]);
    
    for (const key of allKeys) {
      const val1 = breakdown1[key] || 0;
      const val2 = breakdown2[key] || 0;
      result[key] = addSizeBreakdowns(val1, val2);
    }
    return result;
  }
  
  // Handle mismatched types - prefer the non-zero value
  return breakdown1 || breakdown2 || 0;
}

/**
 * Validates and processes JSON schema generation request
 */
async function processJsonSchema(input: JsonSchemaInput): Promise<JsonSchemaResult> {
  try {
    // Use strategy pattern to ingest JSON content
    const ingestionResult = await jsonIngestionContext.ingest(input.filePath);
    
    if (!ingestionResult.success) {
      // Map strategy errors to existing error format for backward compatibility
      return {
        success: false,
        error: ingestionResult.error
      };
    }

    const jsonContent = ingestionResult.content;

    // Calculate file size in bytes
    const fileSizeBytes = new TextEncoder().encode(jsonContent).length;

    // Generate schema using quicktype with fixed parameters
    try {
      const result = await quicktypeJSON(
        "typescript", 
        "GeneratedType", 
        jsonContent
      );
      
      return {
        success: true,
        schema: result.lines.join('\n'),
        fileSizeBytes
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'quicktype_error',
          message: 'Failed to generate schema',
          details: error
        }
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        type: 'validation_error',
        message: 'Unexpected error during processing',
        details: error
      }
    };
  }
}

/**
 * Validates and processes JSON filter request
 */
async function processJsonFilter(input: JsonFilterInput): Promise<JsonFilterResult> {
  try {
    // Use strategy pattern to ingest JSON content
    const ingestionResult = await jsonIngestionContext.ingest(input.filePath);
    
    if (!ingestionResult.success) {
      // Map strategy errors to existing error format for backward compatibility
      return {
        success: false,
        error: ingestionResult.error
      };
    }

    // Parse JSON
    let parsedData: any;
    try {
      parsedData = JSON.parse(ingestionResult.content);
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'invalid_json',
          message: 'Invalid JSON format in content',
          details: error
        }
      };
    }

    // Apply shape filter
    try {
      const filteredData = extractWithShape(parsedData, input.shape);

      // Convert filtered data to JSON string to check size
      const filteredJson = JSON.stringify(filteredData, null, 2);
      const filteredSize = new TextEncoder().encode(filteredJson).length;

      // Define page size (400KB per page)
      const PAGE_SIZE = 400 * 1024;

      // If under page size, return all data without pagination
      if (filteredSize <= PAGE_SIZE) {
        return {
          success: true,
          filteredData
        };
      }

      // Decode cursor to get pagination state, or start from beginning
      let offset = 0;
      if (input.cursor) {
        const decodedCursor = decodeCursor(input.cursor);
        if (!decodedCursor) {
          return {
            success: false,
            error: {
              type: 'validation_error',
              message: 'Invalid cursor token provided',
              details: { cursor: input.cursor }
            }
          };
        }

        // Validate cursor totalSize matches current data
        if (decodedCursor.totalSize !== filteredSize) {
          return {
            success: false,
            error: {
              type: 'validation_error',
              message: 'Cursor is stale - data has changed since cursor was created',
              details: {
                expectedSize: decodedCursor.totalSize,
                actualSize: filteredSize
              }
            }
          };
        }

        offset = decodedCursor.offset;
      }

      // Validate offset is within bounds
      if (offset >= filteredSize || offset < 0) {
        return {
          success: false,
          error: {
            type: 'validation_error',
            message: `Invalid offset ${offset}. Must be between 0 and ${filteredSize - 1}`,
            details: { offset, totalSize: filteredSize }
          }
        };
      }

      // Calculate byte-range for this page
      const endOffset = Math.min(offset + PAGE_SIZE, filteredSize);

      // Extract the page content using byte offsets
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const fullBytes = encoder.encode(filteredJson);
      const pageBytes = fullBytes.slice(offset, endOffset);
      const pageText = decoder.decode(pageBytes);

      // Calculate next cursor if there's more data
      let nextCursor: string | undefined;
      if (endOffset < filteredSize) {
        nextCursor = encodeCursor({
          offset: endOffset,
          pageSize: PAGE_SIZE,
          totalSize: filteredSize
        });
      }

      return {
        success: true,
        filteredData: pageText,
        nextCursor
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'validation_error',
          message: 'Failed to apply shape filter',
          details: error
        }
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        type: 'validation_error',
        message: 'Unexpected error during processing',
        details: error
      }
    };
  }
}

/**
 * Validates and processes JSON dry run request
 */
async function processJsonDryRun(input: JsonDryRunInput): Promise<JsonDryRunResult> {
  try {
    // Use strategy pattern to ingest JSON content
    const ingestionResult = await jsonIngestionContext.ingest(input.filePath);
    
    if (!ingestionResult.success) {
      // Map strategy errors to existing error format for backward compatibility
      return {
        success: false,
        error: ingestionResult.error
      };
    }

    // Parse JSON
    let parsedData: any;
    try {
      parsedData = JSON.parse(ingestionResult.content);
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'invalid_json',
          message: 'Invalid JSON format in content',
          details: error
        }
      };
    }

    // Calculate size breakdown based on shape
    try {
      const sizeBreakdown = calculateSizeWithShape(parsedData, input.shape);
      
      // Calculate total size of the entire parsed data
      const totalSize = calculateValueSize(parsedData);
      
      // Calculate filtered data size
      const filteredData = extractWithShape(parsedData, input.shape);
      const filteredJson = JSON.stringify(filteredData, null, 2);
      const filteredSize = new TextEncoder().encode(filteredJson).length;
      
      // Calculate recommended chunks (400KB threshold)
      const CHUNK_THRESHOLD = 400 * 1024;
      const recommendedChunks = Math.ceil(filteredSize / CHUNK_THRESHOLD);
      
      return {
        success: true,
        sizeBreakdown,
        totalSize,
        filteredSize,
        recommendedChunks
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'validation_error',
          message: 'Failed to calculate size breakdown',
          details: error
        }
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        type: 'validation_error',
        message: 'Unexpected error during processing',
        details: error
      }
    };
  }
}

// Register JSON schema tool
server.tool(
    "json_schema",
    "Generate TypeScript schema for a JSON file or remote JSON URL. Provide the file path or HTTP/HTTPS URL as the only parameter.",
    {
        filePath: z.string().describe("JSON file path (local) or HTTP/HTTPS URL to generate schema from")
    },
    async ({ filePath }) => {
        try {
            const validatedInput = JsonSchemaInputSchema.parse({
                filePath: filePath
            });
            const result = await processJsonSchema(validatedInput);
            
            if (result.success) {
                // Format file size for display
                const formatFileSize = (bytes: number): string => {
                    if (bytes < 1024) return `${bytes} bytes`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                };

                const fileSizeInfo = `// File size: ${formatFileSize(result.fileSizeBytes)} (${result.fileSizeBytes} bytes)\n\n`;
                
                return {
                    content: [
                        {
                            type: "text",
                            text: fileSizeInfo + result.schema
                        }
                    ]
                };
            } else {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error.message}`
                        }
                    ],
                    isError: true
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Validation error: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    "json_filter",
    "Filter JSON data using a shape object to extract only the fields you want. Uses cursor-based pagination for large results (>400KB). Provide filePath (local file or HTTP/HTTPS URL) and shape parameters.",
    {
        filePath: z.string().describe("Path to the JSON file (local) or HTTP/HTTPS URL to filter"),
        shape: z.unknown().describe(`Shape object (formatted as valid JSON) defining what fields to extract. Use 'true' to include a field, or nested objects for deep extraction.

Examples:
1. Extract single field: {"type": true}
2. Extract multiple fields: {"type": true, "version": true, "source": true}
3. Extract nested fields: {"appState": {"gridSize": true, "viewBackgroundColor": true}}
4. Extract from arrays: {"elements": {"type": true, "x": true, "y": true}} - applies to each array item
5. Complex nested extraction: {
   "type": true,
   "version": true,
   "appState": {
     "gridSize": true,
     "viewBackgroundColor": true
   },
   "elements": {
     "type": true,
     "text": true,
     "x": true,
     "y": true,
     "boundElements": {
       "type": true,
       "id": true
     }
   }
}

Note:
- Arrays are automatically handled - the shape is applied to each item in the array.
- Use json_schema tool to analyse the JSON file schema before using this tool.
- Use json_dry_run tool to get a size breakdown of your desired json shape before using this tool.
- For large results (>400KB), the response will include a nextCursor for pagination. Pass this cursor back to retrieve the next page.
`),
        cursor: z.string().optional().describe("Opaque pagination cursor. Omit for the first request. If the response includes a nextCursor, pass it here to retrieve the next page.")
    },
    async ({ filePath, shape, cursor }) => {
        try {
            // If shape is a string, parse it as JSON
            let parsedShape = shape;
            if (typeof shape === 'string') {
                try {
                    parsedShape = JSON.parse(shape);
                } catch (e) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error: Invalid JSON in shape parameter: ${e instanceof Error ? e.message : String(e)}`
                            }
                        ],
                        isError: true
                    };
                }
            }

            

            const validatedInput = JsonFilterInputSchema.parse({
                filePath,
                shape: parsedShape,
                cursor
            });

            const result = await processJsonFilter(validatedInput);

            if (result.success) {
                // Check if pagination is active
                if (result.nextCursor) {
                    // Return paginated data with nextCursor
                    return {
                        content: [
                            {
                                type: "text",
                                text: result.filteredData // This is already a string when paginated
                            },
                            {
                                type: "text",
                                text: `\n---\nPagination: More data available. Use cursor: ${result.nextCursor}`
                            }
                        ]
                    };
                } else if (typeof result.filteredData === 'string') {
                    // Last page of paginated data (no more cursor)
                    return {
                        content: [
                            {
                                type: "text",
                                text: result.filteredData
                            },
                            {
                                type: "text",
                                text: "\n---\nPagination: End of data"
                            }
                        ]
                    };
                } else {
                    // No pagination - return as normal JSON
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result.filteredData, null, 2)
                            }
                        ]
                    };
                }
            } else {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error.message}`
                        }
                    ],
                    isError: true
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Validation error: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    "json_dry_run",
    "Analyze the size breakdown of JSON data using a shape object to determine granularity. Returns size information in bytes for each specified field, mirroring the shape structure but with size values instead of data.",
    {
        filePath: z.string().describe("Path to the JSON file (local) or HTTP/HTTPS URL to analyze"),
        shape: z.unknown().describe(`Shape object (formatted as valid JSON) defining what to analyze for size. Use 'true' to get total size of a field, or nested objects for detailed breakdown.

Examples:
1. Get size of single field: {"name": true}
2. Get sizes of multiple fields: {"name": true, "email": true, "age": true}
3. Get detailed breakdown: {"user": {"name": true, "profile": {"bio": true}}}
4. Analyze arrays: {"posts": {"title": true, "content": true}} - gets total size of all matching elements
5. Complex analysis: {
   "metadata": true,
   "users": {
     "name": true,
     "settings": {
       "theme": true
     }
   },
   "posts": {
     "title": true,
     "tags": true
   }
}

Note: 
- Returns size in bytes for each specified field
- Output structure mirrors the shape but with size values
- Array analysis returns total size of all matching elements
- Use json_schema tool to understand the JSON structure first`)
    },
    async ({ filePath, shape }) => {
        try {
            // If shape is a string, parse it as JSON
            let parsedShape = shape;
            if (typeof shape === 'string') {
                try {
                    parsedShape = JSON.parse(shape);
                } catch (e) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error: Invalid JSON in shape parameter: ${e instanceof Error ? e.message : String(e)}`
                            }
                        ],
                        isError: true
                    };
                }
            }

            const validatedInput = JsonDryRunInputSchema.parse({
                filePath,
                shape: parsedShape
            });
            
            const result = await processJsonDryRun(validatedInput);
            
            if (result.success) {
                // Format the response with total size and breakdown
                const formatSize = (bytes: number): string => {
                    if (bytes < 1024) return `${bytes} bytes`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                };

                const header = `Total file size: ${formatSize(result.totalSize)} (${result.totalSize} bytes)\nFiltered size: ${formatSize(result.filteredSize)} (${result.filteredSize} bytes)\nRecommended chunks: ${result.recommendedChunks}\n\nSize breakdown:\n`;
                const breakdown = JSON.stringify(result.sizeBreakdown, null, 2);
                
                return {
                    content: [
                        {
                            type: "text",
                            text: header + breakdown
                        }
                    ]
                };
            } else {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error.message}`
                        }
                    ],
                    isError: true
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Validation error: ${error instanceof Error ? error.message : String(error)}`
                    }
                ],
                isError: true
            };
        }
    }
);
  
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("JSON MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});