# dev-pipeline-local

Connects a local TypeScript or JavaScript repository to Dev Pipeline so approved work can be implemented and verified safely.

```bash
npx github:alexvernikov/dev-pipeline-local connect --url=https://your-pipeline.example
```

Run the command from the repository root. It opens the pipeline in your browser for project authorization, verifies the repository, and waits for approved work. It uses a temporary Git worktree and never edits your current checkout.
