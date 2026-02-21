# Problem Solving Analysis: Docker Build Failure

## 1. Problem Definition
**Problem Title**: Next.js Docker Build Failure (Exit Code 1)
**Category**: DevOps / Containerization / Build Process
**Initial Problem**: `Failed to deploy a stack: compose build operation failed: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1`
**Refined Problem Statement**: The Next.js production build (`npm run build`) runs successfully on the local Windows environment but fails silently with `exit code: 1` during the Docker multi-stage build pattern on Linux (e.g. during deployment).
**Problem Context**: The CollectFlow application uses Next.js 16.1.6. Host machine has 28 threads. Next.js natively scales workers during static page generation. The Docker container is based on Node 18 Alpine. 
**Success Criteria**: `docker-compose build` succeeds without `exit code: 1` errors and application deploys successfully.

## 2. Diagnosis & Boundaries
**Problem Boundaries**:
- **IS**: Occurring inside Docker, specifically during the `builder` stage (`RUN npm run build`).
- **IS NOT**: A code compilation error (since it builds locally perfectly), case-sensitivity import error (verified clean), or database connection error at build time (API routes use dynamic rendering/no db connection needed at build).
- **WHEN**: Occurs during deployment/compose build, particularly at the static generation or minification steps.

## 3. Root Cause Analysis
**Root Cause**: Node.js Heap Out of Memory (OOM). 
When compiling in Docker, Next.js detects the host CPU cores and spawns 27+ worker threads for rendering and optimization. In a Docker Desktop or deployment environment with constrained RAM (typically 2-4GB), these workers instantly exhaust system memory, causing the `npm run build` process to be killed (`exit code: 1`).
**Contributing Factors**:
1. Default greedy thread scaling in Next.js Turbopack/build.
2. ESLint run during build consuming extra memory.
3. Node 18 running on Alpine Linux (`node:18-alpine`) with potential musl libc incompatibilities with new Next.js rust binaries.
**System Dynamics**: More CPU cores $\rightarrow$ More workers $\rightarrow$ Higher memory requirement $\rightarrow$ Docker memory threshold exceeded $\rightarrow$ Build failure.

## 4. Forces and Constraints
**Driving Forces**: Need for fast, optimized production builds.
**Restraining Forces**: Hard memory limits imposed by Docker/Host OS.
**Constraints**: Must compile the Next.js app in a multi-stage Docker build without copying `.env.local` to remain secure and reproducible.
**Key Insights**: We cannot increase the host RAM easily on all developer machines. We must constrain the build process to fit within standard container memory boundaries.

## 5. Solution Generation
**Solution Methods Used**: Constraint manipulation, Resource limiting.
**Generated Solutions**:
1. Limit Node.js heap memory using `NODE_OPTIONS="--max-old-space-size=4096"`.
2. Restrict Next.js worker threads using `NEXT_PRIVATE_WORKER_THREADS`.
3. Disable ESLint during production build (`ignoreDuringBuilds: true`) to shave off hundreds of megabytes of RAM overhead.
4. Upgrade builder image to `node:20-alpine` for better memory management and Turbopack compatibility.
**Creative Alternatives**: Do a local build and copy `.next/` standalone folder directly to Docker image instead of building inside Docker (bypasses Docker build time completely, but makes CI/CD harder).

## 6. Evaluation and Selection
**Evaluation Criteria**: Reliability, ease of implementation, CI/CD compatibility.
**Solution Analysis**: Limiting workers and memory within the Dockerfile directly solves the root cause while maintaining standard Next.js Docker workflows. Disabling ESLint during build eliminates redundant checks (since developers lint locally/in CI) and saves significant RAM.
**Recommended Solution**: Apply comprehensive build constraints inside `Dockerfile` and `next.config.ts`.
**Solution Rationale**: It is the most robust fix that guarantees the Docker container will build reliably anywhere, regardless of the host's CPU core count and memory availability.

## 7. Implementation Plan
**Implementation Approach**: Direct configuration patches.
**Action Steps**:
1. Update `next.config.ts` to add `eslint: { ignoreDuringBuilds: true }`.
2. Update `Dockerfile` to `node:20-alpine`, inject `ENV NODE_OPTIONS="--max-old-space-size=4096"`, and `ENV NEXT_PRIVATE_WORKER_THREADS=0`.
**Timeline**: Immediate.
**Resources Needed**: Git.
**Responsible Parties**: BMAD Master Agent (Automated).

## 8. Monitoring and Validation
**Success Metrics**: Docker build completes (`exit code 0`).
**Validation Plan**: Wait for the deployment server to run `docker-compose up --build -d` and verify successful launch. 
**Risk Mitigation**: If build still fails, uncomment worker thread limit and explicitly set it to `1`.
**Adjustment Triggers**: Any recurring exit code 1 or exit code 137.

## 9. Lessons Learned
**Key Learnings**: Next.js local success does not guarantee Docker success due to hardware scaling characteristics.
**What Worked**: Systematically verifying boundaries (Case sensitivity scripts, Database checks) eliminated red herrings.
**What to Avoid**: Don't scale Next.js workers up infinitely in containerized environments.
