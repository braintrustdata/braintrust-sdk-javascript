import { expect, test } from "vite-plus/test";
import { camelToSnakeCase, _urljoin } from "./string_util";

test("_urljoin", () => {
  expect(_urljoin("/a", "/b", "/c")).toBe("a/b/c");
  expect(_urljoin("a", "b", "c")).toBe("a/b/c");
  expect(_urljoin("/a/", "/b/", "/c/")).toBe("a/b/c/");
  expect(_urljoin("a/", "b/", "c/")).toBe("a/b/c/");
  expect(_urljoin("", "a", "b", "c")).toBe("a/b/c");
  expect(_urljoin("a", "", "c")).toBe("a/c");
  expect(_urljoin("/", "a", "b", "c")).toBe("a/b/c");
  expect(_urljoin("http://example.com", "api", "v1")).toBe(
    "http://example.com/api/v1",
  );
  expect(_urljoin("http://example.com/", "/api/", "/v1/")).toBe(
    "http://example.com/api/v1/",
  );
  expect(_urljoin()).toBe("");
  expect(_urljoin("a")).toBe("a");
});

test("camelToSnakeCase", () => {
  expect(camelToSnakeCase("myVariable")).toBe("my_variable");
  expect(camelToSnakeCase("MyVariable")).toBe("my_variable");
  expect(camelToSnakeCase("MyVariableName")).toBe("my_variable_name");
  expect(camelToSnakeCase("myVariableName")).toBe("my_variable_name");
  expect(camelToSnakeCase("my_variable_name")).toBe("my_variable_name");
  expect(camelToSnakeCase("my_variable")).toBe("my_variable");
  expect(camelToSnakeCase("my_variable_name")).toBe("my_variable_name");
  expect(camelToSnakeCase("MYVARIABLENAME")).toBe(
    "m_y_v_a_r_i_a_b_l_e_n_a_m_e",
  );
});
