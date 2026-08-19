#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = promisify(execCallback);

// Load projects configuration
let projectsConfig;
try {
  const configPath = path.join(__dirname, 'projects.json');
  const configData = await readFile(configPath, 'utf-8');
  projectsConfig = JSON.parse(configData);
} catch (error) {
  console.error('Error loading projects.json:', error.message);
  console.error('Please create projects.json from projects.example.json');
  process.exit(1);
}

// Git operations helper
class OverleafGitClient {
  constructor(projectId, gitToken) {
    this.projectId = projectId;
    this.gitToken = gitToken;
    this.repoPath = path.join(os.tmpdir(), `overleaf-${projectId}`);
    this.gitUrl = `https://git.overleaf.com/${projectId}`;
  }

  async cloneOrPull() {
    try {
      // Check if repo exists
      await exec(`test -d "${this.repoPath}/.git"`);
      // Pull latest changes
      const { stdout } = await exec(`cd "${this.repoPath}" && git pull`, {
        env: { ...process.env, GIT_ASKPASS: 'echo', GIT_PASSWORD: this.gitToken }
      });
      return stdout;
    } catch {
      // Clone repo - Overleaf requires format: https://git:TOKEN@git.overleaf.com/PROJECT_ID
      const { stdout } = await exec(
        `git clone https://git:${this.gitToken}@git.overleaf.com/${this.projectId} "${this.repoPath}"`
      );
      return stdout;
    }
  }

  async listFiles(extension = '.tex') {
    await this.cloneOrPull();
    const { stdout } = await exec(
      `find "${this.repoPath}" -name "*${extension}" -type f`
    );
    return stdout
      .split('\n')
      .filter(f => f)
      .map(f => f.replace(this.repoPath + '/', ''));
  }

  async readFile(filePath) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    return await readFile(fullPath, 'utf-8');
  }

  async getSections(filePath) {
    const content = await this.readFile(filePath);
    const sections = [];
    const sectionRegex = /\\(?:section|subsection|subsubsection)\{([^}]+)\}/g;
    let match;
    
    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({
        title: match[1],
        type: match[0].split('{')[0].replace('\\', ''),
        index: match.index
      });
    }
    
    return sections;
  }

  async getSectionContent(filePath, sectionTitle) {
    const content = await this.readFile(filePath);
    const sections = await this.getSections(filePath);
    
    const targetSection = sections.find(s => s.title === sectionTitle);
    if (!targetSection) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }
    
    const nextSection = sections.find(s => s.index > targetSection.index);
    const startIdx = targetSection.index;
    const endIdx = nextSection ? nextSection.index : content.length;
    
    return content.substring(startIdx, endIdx);
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'overleaf-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to get project
function getProject(projectName = 'default') {
  const project = projectsConfig.projects[projectName];
  if (!project) {
    throw new Error(`Project "${projectName}" not found in configuration`);
  }
  return new OverleafGitClient(project.projectId, project.gitToken);
}

// List all projects
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_projects',
        description: 'List all configured Overleaf projects',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_files',
        description: 'List files in an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Project identifier (optional, defaults to "default")',
            },
            extension: {
              type: 'string',
              description: 'File extension filter (optional, e.g., ".tex")',
            },
          },
        },
      },
      {
        name: 'read_file',
        description: 'Read a file from an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_sections',
        description: 'Get all sections from a LaTeX file',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_section_content',
        description: 'Get content of a specific section',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            sectionTitle: {
              type: 'string',
              description: 'Title of the section',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'sectionTitle'],
        },
      },
      {
        name: 'status_summary',
        description: 'Get a comprehensive project status summary',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'list_projects': {
        const projects = Object.entries(projectsConfig.projects).map(([key, project]) => ({
          id: key,
          name: project.name,
          projectId: project.projectId,
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      }

      case 'list_files': {
        const client = getProject(args.projectName);
        const files = await client.listFiles(args.extension || '.tex');
        return {
          content: [
            {
              type: 'text',
              text: files.join('\n'),
            },
          ],
        };
      }

      case 'read_file': {
        const client = getProject(args.projectName);
        const content = await client.readFile(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'get_sections': {
        const client = getProject(args.projectName);
        const sections = await client.getSections(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sections, null, 2),
            },
          ],
        };
      }

      case 'get_section_content': {
        const client = getProject(args.projectName);
        const content = await client.getSectionContent(args.filePath, args.sectionTitle);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'status_summary': {
        const client = getProject(args.projectName);
        const projectConfig = projectsConfig.projects[args.projectName || 'default'];
        const files = await client.listFiles();
        const mainFile = (projectConfig?.mainFile && files.includes(projectConfig.mainFile) && projectConfig.mainFile)
          || files.find(f => f.includes('main.tex'))
          || files[0];
        let sections = [];
        
        if (mainFile) {
          sections = await client.getSections(mainFile);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalFiles: files.length,
                mainFile,
                totalSections: sections.length,
                files: files.slice(0, 10),
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Overleaf MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});