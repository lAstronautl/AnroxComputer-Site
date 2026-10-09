# frozen_string_literal: true

# Sort site.posts by front-matter `number` (descending: newest = highest
# number) instead of Jekyll's default date-based order, since most posts
# on this site share the same placeholder date.
Jekyll::Hooks.register :site, :post_read do |site|
  next unless site.posts.docs.any? { |doc| doc.data.key?("number") }

  sorted = site.posts.docs.sort_by { |doc| -(doc.data["number"] || 0) }
  site.posts.docs.replace(sorted)
end
