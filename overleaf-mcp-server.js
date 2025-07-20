// Load project configuration
// const fs = require('fs');
// const path = require('path');

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let projectsConfig = {};
try {
  const projectsFile = fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8');
  projectsConfig = JSON.parse(projectsFile);
} catch (err) {
  // Ignore if projects.json file doesn't exist
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OverleafGitClient from './overleaf-git-client.js';

const server = new Server(
  {
    name: 'overleaf-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Tools list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_files',
        description: 'List all files in an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            extension: { type: 'string', description: 'File extension filter (e.g., .tex)', default: '.tex' },
            projectName: { type: 'string', description: 'Project name (default, project2, etc.)' },
            gitToken: { type: 'string', description: 'Git token (optional, uses env var)' },
            projectId: { type: 'string', description: 'Project ID (optional, uses env var)' }
          },
          additionalProperties: false
        }
      },
      {
        name: 'read_file',
        description: 'Read a file from an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file' },
            projectName: { type: 'string', description: 'Project name (default, project2, etc.)' },
            gitToken: { type: 'string', description: 'Git token (optional, uses env var)' },
            projectId: { type: 'string', description: 'Project ID (optional, uses env var)' }
          },
          required: ['filePath'],
          additionalProperties: false
        }
      },
      {
        name: 'get_sections',
        description: 'Get all sections from a LaTeX file',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the LaTeX file' },
            projectName: { type: 'string', description: 'Project name (default, project2, etc.)' },
            gitToken: { type: 'string', description: 'Git token (optional, uses env var)' },
            projectId: { type: 'string', description: 'Project ID (optional, uses env var)' }
          },
          required: ['filePath'],
          additionalProperties: false
        }
      },
      {
        name: 'get_section_content',
        description: 'Get content of a specific section',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the LaTeX file' },
            sectionTitle: { type: 'string', description: 'Title of the section' },
            projectName: { type: 'string', description: 'Project name (default, project2, etc.)' },
            gitToken: { type: 'string', description: 'Git token (optional, uses env var)' },
            projectId: { type: 'string', description: 'Project ID (optional, uses env var)' }
          },
          required: ['filePath', 'sectionTitle'],
          additionalProperties: false
        }
      },
      {
        name: 'status_summary',
        description: 'Get a summary of the project status using default credentials',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: { type: 'string', description: 'Project name (default, project2, etc.)' }
          },
          additionalProperties: false
        }
      },
      {
        name: 'list_projects',
        description: 'List all available projects',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    ]
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    // Get project information
    function getProjectConfig(projectName) {
      if (projectName && projectsConfig.projects && projectsConfig.projects[projectName]) {
        return projectsConfig.projects[projectName];
      }
      // Use 'default' project as fallback
      if (projectsConfig.projects && projectsConfig.projects.default) {
        return projectsConfig.projects.default;
      }
      throw new Error('No project configuration found. Please set up projects.json with at least a "default" project.');
    }
    
    const projectConfig = getProjectConfig(args.projectName);
    const gitToken = args.gitToken || projectConfig.gitToken;
    const projectId = args.projectId || projectConfig.projectId;
    
    if (!gitToken || !projectId) {
      throw new Error('Git token and project ID are required. Set in projects.json or environment variables.');
    }
    
    const client = new OverleafGitClient(gitToken, projectId);
    
    switch (name) {
      case 'list_files':
        const files = await client.listFiles(args.extension || '.tex');
        return {
          content: [{
            type: 'text',
            text: `Files found: ${files.length}\n\n${files.map(f => `• ${f}`).join('\n')}`
          }]
        };
      
      case 'read_file':
        const content = await client.readFile(args.filePath);
        return {
          content: [{
            type: 'text',
            text: `File: ${args.filePath}\nSize: ${content.length} characters\n\n${content}`
          }]
        };
      
      case 'get_sections':
        const sections = await client.getSections(args.filePath);
        const sectionSummary = sections.map((s, i) => 
          `${i + 1}. [${s.type}] ${s.title}\n   Content preview: ${s.content.substring(0, 100).replace(/\s+/g, ' ')}...`
        ).join('\n\n');
        return {
          content: [{
            type: 'text',
            text: `Sections in ${args.filePath} (${sections.length} total):\n\n${sectionSummary}`
          }]
        };
      
      case 'get_section_content':
        const section = await client.getSection(args.filePath, args.sectionTitle);
        if (!section) {
          throw new Error(`Section "${args.sectionTitle}" not found`);
        }
        return {
          content: [{
            type: 'text',
            text: `Section: ${section.title}\nType: ${section.type}\nContent length: ${section.content.length} characters\n\n${section.content}`
          }]
        };
      
      case 'list_projects':
        const projectList = Object.entries(projectsConfig.projects || {}).map(([key, project]) => 
          `• ${key}: ${project.name} (${project.projectId})`
        );
        return {
          content: [{
            type: 'text',
            text: `Available Projects:\n\n${projectList.join('\n') || 'No projects configured in projects.json'}`
          }]
        };
      
      case 'status_summary':
        // Project status summary
        const allFiles = await client.listFiles('.tex');
        const projectName = projectConfig.name || 'Unknown Project';
        let summary = `📄 ${projectName} Status Summary\n\n`;
        summary += `Project ID: ${projectId}\n`;
        summary += `Total .tex files: ${allFiles.length}\n`;
        summary += `Files: ${allFiles.join(', ')}\n\n`;
        
        if (allFiles.length > 0) {
          const mainFile = allFiles.find(f => f.includes('main')) || allFiles[0];
          const sections = await client.getSections(mainFile);
          summary += `📋 Structure of ${mainFile}:\n`;
          summary += `Total sections: ${sections.length}\n\n`;
          
          sections.slice(0, 10).forEach((s, i) => {
            summary += `${i + 1}. [${s.type}] ${s.title}\n`;
          });
          
          if (sections.length > 10) {
            summary += `... and ${sections.length - 10} more sections\n`;
          }
        }
        
        return {
          content: [{
            type: 'text',
            text: summary
          }]
        };
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => {});