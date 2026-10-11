import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { createFunctions } from "@/inngest/functions";
import { getPipeline } from "@/runtime";

export const { GET, POST, PUT } = serve({ client: inngest, functions: createFunctions(getPipeline) });
