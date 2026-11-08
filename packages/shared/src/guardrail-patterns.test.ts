import { describe, expect, it } from "vitest";
import { givesSafetyAdvice, mentionsPrice, promisesTime } from "./guardrail-patterns.ts";

// Everyday British phrasing the agent (or a profile) might use. Each list was checked against
// the patterns as they were before: the "now caught" ones used to slip through.
describe("mentionsPrice", () => {
  it.each([
    "That'll be about £80 for the call-out.",
    "It will cost around 120 pounds.",
    "The call-out fee is sixty quid.",
    "Our rates start at 45 an hour.",
    "He charges £50 per hour.",
    "Don't worry, there's no charge for the visit.",
    // Now caught
    "It's usually about eighty for the call-out.",
    "He charges 45 an hour.",
    "It's 45/hr.",
    "Callout is 60 plus VAT.",
    "The call out fee is sixty.",
    "Prices start from 60.",
    "Fifteen quid.",
    "Twelve pounds, near enough.",
    "Roughly two grand for the lot.",
    "Bathrooms start from about 8k.",
    "There's no call-out charge.",
  ])("flags %j", (text) => {
    expect(mentionsPrice(text)).toBe(true);
  });

  it.each([
    "Ant will discuss the cost when he calls back.",
    "Ant will let you know what the call-out fee is when he calls back.",
    "How much do you charge?",
    "Free quotes.",
    "We're open 24 hours a day, 7 days a week.",
    "Emergency call-outs 24/7.",
    "We fit 4K aerials.",
    "Gas Safe registered, number 123456.",
  ])("leaves %j alone", (text) => {
    expect(mentionsPrice(text)).toBe(false);
  });
});

describe("promisesTime", () => {
  it.each([
    "Ant will be with you tomorrow morning.",
    "He can come out today at 3.",
    "She'll pop round within the hour.",
    "Your appointment is at 10 tomorrow.",
    // Now caught
    "He'll ring you back in half an hour.",
    "He'll ring you back this afternoon.",
    "Ant will get back to you this afternoon.",
    "He should be with you in about an hour.",
    "He's coming round first thing tomorrow.",
    "Someone will be out within two hours.",
    "He'll be there within thirty minutes.",
    "Expect a call within the next hour.",
    "He can come Monday morning.",
    "He'll be there by three.",
    "He can come next week.",
    "He'll call you back shortly.",
    "I've pencilled you in for Thursday.",
  ])("flags %j", (text) => {
    expect(promisesTime(text)).toBe(true);
  });

  it.each([
    "Ant will discuss availability when he calls back.",
    "He'll call you back as soon as he can.",
    "Thanks. I've passed that to Ant, who'll aim to get back to you. Goodbye.",
    "Hi, you're through to Wren Plumbing. Ant can call you back. How can I help?",
    // The agent's own deflections, which used to be flagged
    "I can't book you in, but I've noted it's urgent.",
    "I can't promise he can come today.",
    "I can't promise he'll be there within the hour.",
    "We don't book you in over the phone.",
  ])("leaves %j alone", (text) => {
    expect(promisesTime(text)).toBe(false);
  });

  it("still flags a promise after a deflection in another clause", () => {
    expect(promisesTime("I can't say exactly, but he'll call you back today.")).toBe(true);
  });
});

describe("givesSafetyAdvice", () => {
  it.each([
    "If you smell gas, turn it off at the meter and open the windows.",
    "Turn off the electrics at the fuse box.",
    "Turn your stopcock off.",
    "Don't use any light switches.",
    "Leave the house and wait outside.",
    "Isolate the supply first.",
    // Now caught: what a model says when it paraphrases a safety message or answers a question
    "Switch it off at the wall for now.",
    "Switch off the power at the fuse box.",
    "I'd unplug the boiler to be safe.",
    "You should call 999.",
    "Please ring the National Gas Emergency Service.",
    "Get everyone out of the house.",
    "Keep the windows and doors open till he's there.",
    "Don't touch the socket.",
    "Okay. Please don't go back inside until it's checked.",
    // Missed until the subagent review of 2026-11-08
    "If you can turn off the water at the stopcock, please do.",
    "If you need to call 999, hang up now.",
    "Get out of the house now.",
    "Don't use the light switches.",
    "Call the emergency services.",
  ])("flags %j", (text) => {
    expect(givesSafetyAdvice(text)).toBe(true);
  });

  it.each([
    "We can show you where your stopcock is.",
    "Boiler servicing and repairs.",
    "Window and door locks fitted.",
    // The agent saying it can't advise, and what the tradesperson does on the job
    "I can't say whether to unplug the boiler, but I'll tell Ant straight away.",
    "I'm not able to tell you if you should switch it off.",
    "He'll turn the water off when he gets there.",
    "We don't touch gas appliances.",
    "Do you cover areas outside Leeds?",
    // Flagged until the subagent review of 2026-11-08: declines the prompt asks for, questions
    // about what the caller managed, and a locksmith's everyday wording
    "I can't advise you to turn the electrics off, but Ant will be told straight away.",
    "I can't tell you to switch it off.",
    "Ant will tell you whether to turn it off when he calls.",
    "So you can't turn it off at the stopcock?",
    "Were you able to turn the water off?",
    "We get doors open fast, without damage.",
    "Can you get doors open without damage?",
    "We switch the power off while we work.",
  ])("leaves %j alone", (text) => {
    expect(givesSafetyAdvice(text)).toBe(false);
  });
});
