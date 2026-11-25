// Code formatter (apps/web/src/lib/format.ts), pure functions, no services needed.
//  (a) every language: output differs from input only in whitespace (SQL: also keyword case)
//  (b) every language: formatting twice changes nothing (idempotent)
//  (c) exact expected output for Python, C++, Go, Java switch, Ruby, Lua, Bash, SQL
//  (d) strings, comments and multi-line strings are never changed
//  (e) textEdits/applyEdits reproduce the formatted text
//
// Run: npx tsx tests/test-format.ts

import { applyEdits, formatCode, textEdits, CUSTOM_FORMAT_IDS } from "../apps/web/src/lib/format";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "\n" + String(detail).split("\n").map((l) => "        | " + l).join("\n") : ""}`);
};

const SAMPLES: Record<string, string> = {
  python: `import os,sys
def total(items):
  subtotal=sum(i.price*i.qty for i in items)
  if subtotal>100:
        return round(subtotal*0.9,2) #discount
  return subtotal
class Cart:
  def __init__(self,items=None):
    self.items=items or []
  def add(self,x):
    self.items.append(x)
s = """keep   this
   exactly=1,2 """
print(total([]),f(a=1,b=2))
`,
  cpp: `#include <iostream>
#include <vector>
int main(){
std::vector<int> v={1,2,3};
for(int i=0;i<3;i++){
if(v[i]>1){std::cout<<"big, "<<v[i]<<"\\n";}
else{
std::cout<<"small"<<std::endl;
}
}
/* block
comment */
return 0;
}
`,
  c: `#include <stdio.h>
int main(void){
int x=5;
  #ifdef DEBUG
printf("x=%d\\n",x);
  #endif
return 0;}
`,
  java: `public class Main{
public static void main(String[] args){
int day=2;
switch(day){
case 1:
System.out.println("Mon");
break;
default:
System.out.println("Other");
}
String t = """
    text block { not code
    """;
}
}
`,
  go: `package main
import "fmt"
func main(){
x:=3
switch x{
case 1:
fmt.Println("one")
default:
fmt.Println("many")
}
raw:=\`line {
  two\`
fmt.Println(raw)
}
`,
  rust: `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
if x.len()>y.len(){x}else{y}
}
fn main(){
let c='{';
let r=0..=10;
println!("{} {}",longest("ab","c"),c);
}
`,
  csharp: `using System;
class P{
static void Main(){
var xs=new[]{1,2,3};
foreach(var x in xs){Console.WriteLine(x);}
}
}
`,
  kotlin: `fun main(){
val x=when(3){
1->"one"
else->"many"
}
println(x)
}
`,
  swift: `let names=["a","b"]
for n in names{
if n=="a"{print(n)}
}
`,
  scala: `object Main{
def main(args:Array[String]):Unit={
val xs=List(1,2,3)
xs.foreach(x=>println(x))
}
}
`,
  dart: `void main(){
var xs=[1,2,3];
for(var x in xs){
print('v: $x');
}
}
`,
  php: `<?php
function add($a,$b){
return $a+$b; # sum
}
echo add(1,2);
`,
  sol: `pragma solidity ^0.8.0;
contract C{
uint x;
function set(uint v) public{x=v;}
}
`,
  r: `f <- function(x){
if(x>1){
print("big")
}
}
f(2)
`,
  powershell: `function Add($a,$b){
if($a -gt $b){
return $a
}
}
`,
  perl: `my %h=(a=>1);
foreach my $k (keys %h){
print "$k\\n" if $k=~/a/;
}
`,
  ruby: `class Greeter
def initialize(name)
@name=name
end
def greet
if @name
puts "Hi, #{@name}"
else
puts "Hi"
end
[1,2].each do |x|
puts x
end
end
end
`,
  lua: `local function fact(n)
if n<=1 then
return 1
else
return n*fact(n-1)
end
end
for i=1,3 do
print(fact(i))
end
`,
  elixir: `defmodule M do
def hi(name) do
if name do
IO.puts("hi")
else
IO.puts("none")
end
end
end
`,
  julia: `function f(x)
if x>1
println("big")
else
println("small")
end
end
`,
  pascal: `program Hello;
begin
if true then
begin
writeln('hi');
end;
end.
`,
  vb: `Module Program
Sub Main()
For i As Integer = 1 To 3
If i > 1 Then
Console.WriteLine(i)
Else
Console.WriteLine("one")
End If
Next
End Sub
End Module
`,
  shell: `#!/bin/bash
for f in a b; do
if [ "$f" = "a" ]; then
echo "one # not a comment"
elif [ -n "$f" ]; then
echo two
else
echo three
fi
done
`,
  clojure: `(defn fact [n]
(if (<= n 1)
1
(* n (fact (dec n)))))
(println (fact 5) \\()
`,
  scheme: `(define (sq x)
(* x x))
(display (sq 3))
`,
  sql: `select id,name from users u left join orders o on o.user_id=u.id where u.active=true and o.total>10 order by name;
insert into t(a,b) values (1,'it''s a select from where');
`,
  fsharp: `let add a b =
    a+b


printfn "%d" (add 1 2)
`,
  coffeescript: `square = (x) -> x*x
console.log square 3
`,
};

const squash = (s: string) => s.replace(/\s+/g, "");

console.log("(a)(b) every language: whitespace-only and idempotent");
for (const id of CUSTOM_FORMAT_IDS) {
  const src = SAMPLES[id];
  if (!src) { check(`${id}: has a sample`, false); continue; }
  const once = formatCode(src, id);
  const twice = formatCode(once, id);
  const same = id === "sql" ? squash(once).toLowerCase() === squash(src).toLowerCase() : squash(once) === squash(src);
  check(`${id}: only whitespace changed`, same, once);
  check(`${id}: idempotent`, twice === once, twice);
}

console.log("(c) expected output");
const expect = (name: string, id: string, src: string, want: string) => {
  const got = formatCode(src, id);
  check(name, got === want, `--- got ---\n${got}--- want ---\n${want}`);
};
expect("python: 4-space levels, PEP 8 spacing and blank lines", "python", SAMPLES.python, `import os, sys


def total(items):
    subtotal = sum(i.price*i.qty for i in items)
    if subtotal > 100:
        return round(subtotal*0.9, 2)  # discount
    return subtotal


class Cart:
    def __init__(self, items=None):
        self.items = items or []

    def add(self, x):
        self.items.append(x)


s = """keep   this
   exactly=1,2 """
print(total([]), f(a=1, b=2))
`);
expect("cpp: braces, keyword/operator spacing", "cpp", SAMPLES.cpp, `#include <iostream>
#include <vector>
int main() {
    std::vector<int> v = {1, 2, 3};
    for (int i = 0; i<3; i++) {
        if (v[i]>1) {std::cout<<"big, "<<v[i]<<"\\n";}
        else {
            std::cout<<"small"<<std::endl;
        }
    }
    /* block
    comment */
    return 0;
}
`);
expect("go: tabs, case at switch level, raw string kept", "go", SAMPLES.go, `package main
import "fmt"
func main() {
\tx := 3
\tswitch x {
\tcase 1:
\t\tfmt.Println("one")
\tdefault:
\t\tfmt.Println("many")
\t}
\traw := \`line {
  two\`
\tfmt.Println(raw)
}
`);
expect("java: case bodies indented, text block untouched", "java", SAMPLES.java, `public class Main {
    public static void main(String[] args) {
        int day = 2;
        switch (day) {
            case 1:
                System.out.println("Mon");
                break;
            default:
                System.out.println("Other");
        }
        String t = """
    text block { not code
    """;
    }
}
`);
expect("ruby: def/if/do...end", "ruby", SAMPLES.ruby, `class Greeter
  def initialize(name)
    @name=name
  end
  def greet
    if @name
      puts "Hi, #{@name}"
    else
      puts "Hi"
    end
    [1,2].each do |x|
      puts x
    end
  end
end
`);
expect("lua: function/if/for...end", "lua", SAMPLES.lua, `local function fact(n)
    if n<=1 then
        return 1
    else
        return n*fact(n-1)
    end
end
for i=1,3 do
    print(fact(i))
end
`);
expect("bash: for/if/elif/else, # in a string is not a comment", "shell", SAMPLES.shell, `#!/bin/bash
for f in a b; do
    if [ "$f" = "a" ]; then
        echo "one # not a comment"
    elif [ -n "$f" ]; then
        echo two
    else
        echo three
    fi
done
`);
expect("sql: clauses on their own lines, keywords upper-case, strings kept", "sql", SAMPLES.sql, `SELECT id,name
FROM users u
LEFT JOIN orders o ON o.user_id=u.id
WHERE u.active=TRUE
  AND o.total>10
ORDER BY name;

INSERT INTO t(a,b)
VALUES (1,'it''s a select from where');
`);

console.log("(d) strings and comments untouched");
check("python string with a=1,2 kept", formatCode(SAMPLES.python, "python").includes('   exactly=1,2 """'));
check("rust lifetimes don't break brace depth", formatCode(SAMPLES.rust, "rust").endsWith(`    println!("{} {}", longest("ab", "c"), c);\n}\n`), formatCode(SAMPLES.rust, "rust"));
check("rust ..= range kept", formatCode(SAMPLES.rust, "rust").includes("0..=10"));
check("perl =~ kept (no spacing that changes meaning)", formatCode(SAMPLES.perl, "perl").includes("$k=~/a/"));
check("clojure \\( char literal doesn't change depth", formatCode(SAMPLES.clojure, "clojure").endsWith("(println (fact 5) \\()\n"));
check("empty input stays empty", formatCode("   \n\n", "python") === "");
check("CRLF input becomes LF", !formatCode("x=1\r\ny=2\r\n", "python").includes("\r"));

console.log("(e) edits");
for (const id of ["python", "cpp", "sql", "go"]) {
  const after = formatCode(SAMPLES[id], id);
  check(`${id}: applying textEdits gives the formatted text`, applyEdits(SAMPLES[id], textEdits(SAMPLES[id], after)) === after);
}
const reindent = textEdits("a\n  b\nc\n", "a\n    b\nc\n");
check("re-indent touches only the changed line", reindent.length === 1 && reindent[0].start === 2 && reindent[0].text === "    b", JSON.stringify(reindent));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
